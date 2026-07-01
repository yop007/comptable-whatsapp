import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquante");
if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL manquante");
if (!process.env.SUPABASE_ANON_KEY) throw new Error("SUPABASE_ANON_KEY manquante");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  realtime: { transport: ws },
});
const pendingCancellations = {};
const pendingPins = {};
const pendingPinRecovery = {};
const pendingNumberChange = {};
const pendingTutorial = {};

const SYSTEM_PROMPT = `Tu es un assistant comptable pour des commercants en Guinee.
Extrait les informations du message et retourne UNIQUEMENT un JSON valide.

Regles importantes :
- "elle a pris", "il a pris", "a pris de la marchandise" = credit
- "il a paye", "elle a paye", "a rembourse", "a paye" = remboursement
- "combien X me doit", "qu est ce que X me doit" = bilan avec client renseigne
- Si le type est inconnu mais qu il y a un montant, essaie de deduire le contexte
- "quel est le bilan", "montre moi le bilan", "voir le bilan", "mon bilan" = bilan
- "bilan du jour", "bilan journalier", "bilan d aujourd hui" = bilan, periode: jour
- "bilan du mois", "bilan mensuel" = bilan, periode: mois
- "vt", "vente" = vente
- "dp", "dep", "depense" = depense
- "cr", "credit" = credit
- "rb", "remb" = remboursement
- "bl", "bilan" = bilan
- "blj", "bilan jour" = bilan, periode: jour
- "blm", "bilan mois" = bilan, periode: mois
- "qui me doit", "liste des credits", "mes credits", "liste credits", "lc" = credits_liste
- "aide", "help", "commandes", "?" = aide
- "annuler", "supprimer", "erreur", "annule" = annuler
- "oui", "yes", "confirmer" = confirmer
- "non", "no", "annuler" = refuser
- "mode perso", "perso", "maison", "personnel" = mode_perso
- "mode business", "business", "boutique", "commerce" = mode_business
- "mon mode", "quel mode", "mode actif" = voir_mode
- "loyer", "logement", "louer" = budget_depense, categorie: loyer
- "nourriture", "courses", "marche", "alimentation", "manger", "repas" = budget_depense, categorie: nourriture
- "transport", "taxi", "carburant", "essence", "bus" = budget_depense, categorie: transport
- "sante", "medecin", "medicaments", "pharmacie", "hopital", "clinique" = budget_depense, categorie: sante
- "eau", "electricite", "facture", "internet", "telephone" = budget_depense, categorie: factures
- "ecole", "scolarite", "frais scolaires", "universite" = budget_depense, categorie: education
- "habit", "vetements", "fringues", "chaussures" = budget_depense, categorie: vetements
- "loisirs", "sortie", "cinema", "restaurant", "vacances" = budget_depense, categorie: loisirs

- "dernieres transactions", "historique", "mes transactions", "liste transactions", "ht" = historique
- "budget", "definir budget", "mon budget", "fixer budget" = budget_definir
- "changer numero", "nouveau numero", "changer mon numero" = changer_numero
- "pin oublie", "oublie pin", "recuperer pin", "mot de passe oublie" = pin_oublie

Retourne ce JSON :
{
  "type": "vente" | "depense" | "credit" | "remboursement" | "bilan" | "credits_liste" | "historique" | "aide" | "annuler" | "confirmer" | "refuser" | "pin_oublie" | "changer_numero" | "mode_perso" | "mode_business" | "voir_mode" | "budget_depense" | "budget_definir" | "inconnu",
  "montant": number | null,
  "devise": string | null,
  "description": string | null,
  "client": string | null,
  "periode": "jour" | "mois" | null,
  "categorie": string | null
}
Aucun texte avant ou apres le JSON.`;

async function getOrCreateUser(telephone) {
  const { data, error } = await supabase
    .from("utilisateurs")
    .select("*")
    .eq("telephone", telephone)
    .single();

  if (error && error.code !== "PGRST116") throw error;

  if (!data) {
    const { data: newUser, error: insertError } = await supabase
      .from("utilisateurs")
      .insert({ telephone })
      .select()
      .single();
    if (insertError) throw insertError;
    return { user: newUser, isNew: true };
  }
  return { user: data, isNew: false };
}

async function extractTransaction(message, mode) {
  const modeInstruction = mode === "perso"
    ? "L utilisateur est en MODE PERSONNEL. Les depenses ambigues comme taxi, courses, restaurant, transport sont des budget_depense avec la bonne categorie. Ne jamais retourner type depense simple en mode perso."
    : "L utilisateur est en MODE BUSINESS. Les transactions sont professionnelles.";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n" + modeInstruction },
      { role: "user", content: message },
    ],
    temperature: 0,
  });
  const raw = response.choices[0].message.content;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Reponse OpenAI invalide (JSON malforme) : " + raw);
  }
}

async function saveTransaction(userId, extracted) {
  if (extracted.client) {
    extracted.client = extracted.client.charAt(0).toUpperCase() + extracted.client.slice(1).toLowerCase();
  }
  const { data, error } = await supabase
    .from("transactions")
    .insert({
      utilisateur_id: userId,
      type: extracted.type,
      montant: extracted.montant,
      description: extracted.description,
      client: extracted.client,
    })
    .select();

  if (error) throw error;
  return data[0];
}

async function getBilan(userId, periode) {
  const from = new Date();
  if (periode === "mois") from.setDate(1);
  from.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("utilisateur_id", userId)
    .gte("created_at", from.toISOString());

  if (error) throw error;
  const transactions = data || [];

  const ventes = transactions.filter(t => t.type === "vente").reduce((s, t) => s + t.montant, 0);
  const depenses = transactions.filter(t => t.type === "depense").reduce((s, t) => s + t.montant, 0);
  const credits = transactions.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
  const remboursements = transactions.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

  return {
    ventes,
    depenses,
    benefice: ventes - depenses,
    credits: credits - remboursements
  };
}

async function getSoldeClient(userId, client) {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("utilisateur_id", userId)
    .ilike("client", "%" + client + "%");

  if (error) throw error;
  const transactions = data || [];

  const credits = transactions.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
  const remboursements = transactions.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

  return credits - remboursements;
}

async function getTier(userId) {
  const { data } = await supabase
    .from("abonnements")
    .select("tier, actif, date_fin")
    .eq("utilisateur_id", userId)
    .single();

  if (!data || !data.actif) return "expire";
  if (data.date_fin && new Date(data.date_fin) < new Date()) return "expire";
  if (data.tier === "gratuit" && data.date_fin && new Date(data.date_fin) > new Date()) return "essai";
  return data.tier || "expire";
}

export async function processMessage(telephone, message) {
  const { user, isNew } = await getOrCreateUser(telephone);

  if (isNew) {
    pendingPins[telephone] = { step: "create" };
    return "Bienvenue sur Bilan Pro !\n\nPour securiser ton compte, cree un code PIN a 4 chiffres.\nCe code te permettra de recuperer ton compte si tu changes de numero.\n\nEnvoie ton PIN a 4 chiffres :";
  }

  if (!user.pin_confirme && !pendingPins[telephone]) {
    pendingPins[telephone] = { step: "create" };
    return "Ton compte n a pas encore de PIN configure.\nEnvoie un code a 4 chiffres pour securiser ton compte :";
  }

  const QUESTIONS_SECRETES = [
    "1. Le prenom de ta mere ?",
    "2. Le nom de ton ecole primaire ?",
    "3. Le nom de ta ville natale ?",
    "4. Le prenom de ton meilleur ami d enfance ?",
    "5. Le nom de ton premier animal ?"
  ];

  if (pendingPins[telephone]?.step === "create") {
    if (!/^\d{4}$/.test(message.trim())) {
      return "PIN invalide. Envoie exactement 4 chiffres (ex: 1234)";
    }
    pendingPins[telephone] = { step: "confirm", pin: message.trim() };
    return "Confirme ton PIN en le saisissant a nouveau :";
  }

  if (pendingPins[telephone]?.step === "confirm") {
    if (message.trim() !== pendingPins[telephone].pin) {
      pendingPins[telephone] = { step: "create" };
      return "Les PIN ne correspondent pas. Recommence :";
    }
    pendingPins[telephone] = { step: "question", pin: message.trim() };
    return "PIN confirme !\n\nChoisis une question secrete pour recuperer ton PIN :\n\n" + QUESTIONS_SECRETES.join("\n") + "\n\nReponds avec le numero (1 a 5) :";
  }

  if (pendingPins[telephone]?.step === "question") {
    const choix = parseInt(message.trim());
    if (isNaN(choix) || choix < 1 || choix > 5) {
      return "Choix invalide. Reponds avec un numero entre 1 et 5 :";
    }
    const questions = [
      "Le prenom de ta mere ?",
      "Le nom de ton ecole primaire ?",
      "Le nom de ta ville natale ?",
      "Le prenom de ton meilleur ami d enfance ?",
      "Le nom de ton premier animal ?"
    ];
    pendingPins[telephone] = { step: "reponse", pin: pendingPins[telephone].pin, question: questions[choix - 1] };
    return "Question choisie : " + questions[choix - 1] + "\n\nQuelle est ta reponse ?";
  }

  if (pendingPins[telephone]?.step === "reponse") {
    const reponse = message.trim().toLowerCase();
    if (!reponse) {
      return "Reponse invalide. Essaie a nouveau :";
    }
    await supabase
      .from("utilisateurs")
      .update({
        pin: pendingPins[telephone].pin,
        pin_confirme: true,
        question_secrete: pendingPins[telephone].question,
        reponse_secrete: reponse
      })
      .eq("telephone", telephone);
    delete pendingPins[telephone];

    // Creer abonnement gratuit par defaut (2 semaines)
    const dateDebut = new Date();
    const dateFin = new Date();
    dateFin.setDate(dateFin.getDate() + 14);

    await supabase.from("abonnements").insert({
      utilisateur_id: user.id,
      tier: "gratuit",
      duree: "mensuel",
      date_debut: dateDebut.toISOString(),
      date_fin: dateFin.toISOString(),
      actif: true
    });

    pendingTutorial[telephone] = { step: 1 };

    return "Compte cree avec succes !\n\nBienvenue sur Bilan Pro !\n\nOn va faire un essai rapide ensemble pour que tu voies comment ca marche. Imagine une journee type de ton activite.\n\nÉTAPE 1/4 — Tu fais une vente ?\nTape exactement : vt 1000 test";
  }

  if (pendingPinRecovery[telephone]?.step === "reponse") {
    const reponse = message.trim().toLowerCase();
    if (reponse === pendingPinRecovery[telephone].reponse_secrete) {
      const pin = pendingPinRecovery[telephone].pin;
      delete pendingPinRecovery[telephone];
      return "Bonne reponse !\n\nTon PIN est : " + pin + "\n\nPense a le noter dans un endroit sur.";
    } else {
      pendingPinRecovery[telephone].tentatives = (pendingPinRecovery[telephone].tentatives || 0) + 1;
      if (pendingPinRecovery[telephone].tentatives >= 3) {
        delete pendingPinRecovery[telephone];
        return "Reponse incorrecte 3 fois. Contacte le support pour recuperer ton compte.";
      }
      const restantes = 3 - pendingPinRecovery[telephone].tentatives;
      return "Reponse incorrecte. Il te reste " + restantes + " tentative(s).\n\nQuestion : " + pendingPinRecovery[telephone].question + "\n\nEssaie a nouveau :";
    }
  }

  const tier = await getTier(user.id);

  // Gestion choix annulation en attente
  if (pendingCancellations[user.telephone]?.step === "choix") {
    const choix = parseInt(message.trim());
    const pending = pendingCancellations[user.telephone];
    if (isNaN(choix) || choix < 1 || choix > pending.transactions.length) {
      return "Choix invalide. Reponds avec un numero entre 1 et " + pending.transactions.length + " :";
    }
    const t = pending.transactions[choix - 1];
    pendingCancellations[user.telephone] = { step: "confirmation", id: t.id, transaction: t };
    return "Confirmer la suppression de :\n" +
      t.type.toUpperCase() + " de " + t.montant?.toLocaleString() +
      (t.description ? " - " + t.description : "") +
      (t.client ? " (" + t.client + ")" : "") +
      "\n\nReponds oui pour supprimer ou non pour annuler.";
  }

  // Tutoriel guide apres inscription
  if (pendingTutorial[telephone]) {
    const step = pendingTutorial[telephone].step;
    const texte = message.trim().toLowerCase();

    if (step === 1) {
      if (texte === "vt 1000 test") {
        await saveTransaction(user.id, { type: "vente", montant: 1000, description: "test" });
        pendingTutorial[telephone].step = 2;
        return "✅ Enregistre : vente de 1,000 - test\n\nC'est exactement comme ca que tu enregistreras tes vraies ventes !\n\nÉTAPE 2/4 — Tu as une depense ?\nTape exactement : dp 500 test";
      }
      return "Pour continuer le tutoriel, tape exactement :\nvt 1000 test\n\n(Tu pourras taper \"stop\" pour arreter le tutoriel a tout moment)";
    }

    if (step === 2) {
      if (texte === "stop") { delete pendingTutorial[telephone]; return "Tutoriel arrete. Tape \"aide\" quand tu veux pour voir les commandes."; }
      if (texte === "dp 500 test") {
        await saveTransaction(user.id, { type: "depense", montant: 500, description: "test" });
        pendingTutorial[telephone].step = 3;
        return "✅ Enregistre : depense de 500 - test\n\nMaintenant un credit client !\n\nÉTAPE 3/4 — Un client achete a credit ?\nTape exactement : cr Test 2000";
      }
      return "Pour continuer, tape exactement :\ndp 500 test\n\n(ou \"stop\" pour arreter)";
    }

    if (step === 3) {
      if (texte === "stop") { delete pendingTutorial[telephone]; return "Tutoriel arrete. Tape \"aide\" quand tu veux pour voir les commandes."; }
      if (texte === "cr test 2000") {
        await saveTransaction(user.id, { type: "credit", montant: 2000, client: "Test" });
        pendingTutorial[telephone].step = 4;
        return "✅ Enregistre : credit de 2,000 (client: Test)\n\n💡 Important : la difference entre vt et cr\n\nvt = vente encaissee immediatement (argent recu)\ncr = vente a credit (argent pas encore recu)\n\nLe benefice n augmente qu au moment du remboursement avec rb.\n\nDernier exemple : voir ton bilan du jour !\n\nÉTAPE 4/4 — Tape exactement : blj";
      }
      return "Pour continuer, tape exactement :\ncr Test 2000\n\n(ou \"stop\" pour arreter)";
    }

    if (step === 4) {
      if (texte === "stop") { delete pendingTutorial[telephone]; return "Tutoriel arrete. Tape \"aide\" quand tu veux pour voir les commandes."; }
      if (texte === "blj") {
        delete pendingTutorial[telephone];
        const bilan = await getBilan(user.id, "jour");
        return "Bilan du jour :\nVentes : " + bilan.ventes.toLocaleString() + "\nDepenses : " + bilan.depenses.toLocaleString() + "\nBenefice : " + bilan.benefice.toLocaleString() + "\nCredits accordes : " + bilan.credits.toLocaleString() +
          "\n\n🎉 Bravo, tu connais l'essentiel !\n\nTu peux maintenant utiliser Bilan Pro pour de vrai. Tape \"aide\" a tout moment pour revoir les commandes.\n\nAstuce : Tape \"mode perso\" si tu veux aussi suivre ton budget personnel (loyer, nourriture, transport...).";
      }
      return "Pour terminer, tape exactement :\nblj\n\n(ou \"stop\" pour arreter)";
    }
  }

  // Gestion changement de numero en attente
  if (pendingNumberChange[telephone]?.step === "ancien_numero") {
    const ancienNumero = "whatsapp:" + message.trim().replace(/\s/g, "");
    pendingNumberChange[telephone] = { step: "pin", ancienNumero };
    return "Entrez le PIN de votre ancien compte :";
  }

  if (pendingNumberChange[telephone]?.step === "pin") {
    const { data: ancienUser } = await supabase
      .from("utilisateurs")
      .select("*")
      .eq("telephone", pendingNumberChange[telephone].ancienNumero)
      .single();

    if (!ancienUser || ancienUser.pin !== message.trim()) {
      delete pendingNumberChange[telephone];
      return "Ancien numero ou PIN incorrect. Recommencez avec 'changer numero'.";
    }

    // Transfert du compte
    await supabase.from("transactions")
      .update({ utilisateur_id: user.id })
      .eq("utilisateur_id", ancienUser.id);

    await supabase.from("utilisateurs")
      .update({
        pin: ancienUser.pin,
        pin_confirme: true,
        question_secrete: ancienUser.question_secrete,
        reponse_secrete: ancienUser.reponse_secrete,
        mode_actif: ancienUser.mode_actif,
        budget_mensuel: ancienUser.budget_mensuel
      })
      .eq("telephone", telephone);

    await supabase.from("utilisateurs").delete().eq("id", ancienUser.id);

    delete pendingNumberChange[telephone];
    return "✅ Compte transfere avec succes !\n\nToutes vos transactions ont ete transferees vers ce nouveau numero.";
  }

  const extracted = await extractTransaction(message, user.mode_actif || "business");

  // Aucune restriction pendant la periode d'essai
  // Restrictions uniquement apres expiration ou pour les tiers payants

  if (tier === "expire") {
    if (["budget_depense", "budget_definir", "mode_perso", "historique"].includes(extracted.type)) {
      return "⚠️ Ta periode d'essai est terminee.\n\nContacte-nous sur www.bilanpro.app pour souscrire a un abonnement et continuer a utiliser Bilan Pro.";
    }
    const debutMois = new Date(); debutMois.setDate(1); debutMois.setHours(0,0,0,0);
    const { count } = await supabase.from("transactions").select("*", { count: "exact", head: true }).eq("utilisateur_id", user.id).gte("created_at", debutMois.toISOString());
    if (count >= 10 && ["vente","depense","credit","remboursement"].includes(extracted.type)) {
      return "⚠️ Ta periode d'essai est terminee.\n\nContacte-nous sur www.bilanpro.app pour continuer.";
    }
  }

  if (tier === "pro") {
    if (["budget_depense", "budget_definir"].includes(extracted.type)) {
      return "⚠️ Cette fonctionnalite est disponible uniquement avec le plan Business.\n\nContacte le support pour upgrader ton compte.";
    }
  }

  // Bloquer credit et remboursement en mode perso
  if (user.mode_actif === "perso" && (extracted.type === "credit" || extracted.type === "remboursement")) {
    return "⚠️ Les crédits clients ne sont pas disponibles en mode personnel.\n\nTape 'mode business' pour revenir au mode business.";
  }

  if (extracted.type === "bilan") {
    if (user.mode_actif === "perso") {
      const from = new Date();
      if (extracted.periode === "mois") {
        from.setDate(1);
      }
      from.setHours(0, 0, 0, 0);

      const { data } = await supabase
        .from("transactions")
        .select("*")
        .eq("utilisateur_id", user.id)
        .gte("created_at", from.toISOString())
        .not("categorie", "is", null);

      const transactions = data || [];
      if (transactions.length === 0) return "Aucune depense personnelle enregistree.";

      const emojis = { loyer: "🏠", nourriture: "🛒", transport: "🚗", sante: "💊", factures: "💡", education: "🎓", vetements: "👕", loisirs: "🎉", autre: "📦" };
      const parCategorie = {};
      for (const t of transactions) {
        const cat = t.categorie || "autre";
        if (!parCategorie[cat]) parCategorie[cat] = 0;
        parCategorie[cat] += t.montant;
      }

      const total = Object.values(parCategorie).reduce((s, v) => s + v, 0);
      const lignes = Object.entries(parCategorie)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, montant]) => (emojis[cat] || "📦") + " " + cat.charAt(0).toUpperCase() + cat.slice(1) + " : " + montant.toLocaleString())
        .join("\n");

      return "Bilan perso " + (extracted.periode === "mois" ? "du mois" : "du jour") + " :\n\n" +
        lignes + "\n" +
        "───────────────────\n" +
        "Total depense : " + total.toLocaleString() +
        (user.budget_mensuel ? "\nBudget restant : " + (user.budget_mensuel - total).toLocaleString() + (total > user.budget_mensuel ? " \u26a0\ufe0f BUDGET DEPASSE !" : "") : "");
    }
    if (extracted.client) {
      const solde = await getSoldeClient(user.id, extracted.client);
      return "Solde de " + extracted.client + " :\n" + (solde > 0 ? "Doit encore : " + solde.toLocaleString() + " " + (extracted.devise || "") : "Aucune dette en cours.");
    }

    const bilan = await getBilan(user.id, extracted.periode || "jour");
    const devise = extracted.devise || "";
    return "Bilan " + (extracted.periode === "mois" ? "du mois" : "du jour") + " :\n" +
      "Ventes : " + bilan.ventes.toLocaleString() + " " + devise + "\n" +
      "Depenses : " + bilan.depenses.toLocaleString() + " " + devise + "\n" +
      "Benefice : " + bilan.benefice.toLocaleString() + " " + devise + "\n" +
      "Credits accordes : " + bilan.credits.toLocaleString() + " " + devise;
  }

  if (extracted.type === "historique") {
    const { data } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    if (!data || data.length === 0) return "Aucune transaction enregistree.";

    const emojis = { vente: "✅", depense: "💸", credit: "📋", remboursement: "💰" };
    const liste = data.map((t, i) =>
      (emojis[t.type] || "•") + " " + t.type.toUpperCase() + " " + t.montant?.toLocaleString() +
      (t.description ? " - " + t.description : "") +
      (t.client ? " (" + t.client + ")" : "") +
      " | " + new Date(t.created_at).toLocaleDateString("fr-FR")
    ).join("\n");

    return "5 dernieres transactions :\n\n" + liste;
  }

  if (extracted.type === "credits_liste") {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .in("type", ["credit", "remboursement"]);

    if (error) throw error;
    const transactions = (data || []).filter(t => t.client !== null);

    const soldes = {};
    for (const t of transactions) {
      if (!soldes[t.client]) soldes[t.client] = 0;
      if (t.type === "credit") soldes[t.client] += t.montant;
      if (t.type === "remboursement") soldes[t.client] -= t.montant;
    }

    const debiteurs = Object.entries(soldes)
      .filter(([_, montant]) => montant > 0)
      .sort((a, b) => b[1] - a[1]);

    if (debiteurs.length === 0) return "Aucun credit en cours.";

    const liste = debiteurs
      .map(([client, montant]) => "- " + client + " : " + montant.toLocaleString())
      .join("\n");

    return "Credits en cours :\n" + liste;
  }

  if (extracted.type === "annuler") {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    if (error) throw error;
    if (!data || data.length === 0) return "Aucune transaction a annuler.";

    pendingCancellations[user.telephone] = { step: "choix", transactions: data };

    const liste = data.map((t, i) =>
      (i + 1) + ". " + t.type.toUpperCase() + " de " + t.montant?.toLocaleString() +
      (t.description ? " - " + t.description : "") +
      (t.client ? " (" + t.client + ")" : "") +
      " | " + new Date(t.created_at).toLocaleDateString("fr-FR")
    ).join("\n");

    return "Quelle transaction veux-tu annuler ?\n\n" + liste + "\n\nReponds avec le numero (1 a " + data.length + ") :";
  }

  if (extracted.type === "confirmer") {
    const pending = pendingCancellations[user.telephone];
    if (!pending) return "Aucune suppression en attente.";

    if (pending.step === "choix") {
      const choix = parseInt(message.trim());
      if (isNaN(choix) || choix < 1 || choix > pending.transactions.length) {
        return "Choix invalide. Reponds avec un numero entre 1 et " + pending.transactions.length + " :";
      }
      const t = pending.transactions[choix - 1];
      pendingCancellations[user.telephone] = { step: "confirmation", id: t.id, transaction: t };
      return "Confirmer la suppression de :\n" +
        t.type.toUpperCase() + " de " + t.montant?.toLocaleString() +
        (t.description ? " - " + t.description : "") +
        (t.client ? " (" + t.client + ")" : "") +
        "\n\nReponds oui pour supprimer ou non pour annuler.";
    }

    if (pending.step === "confirmation") {
      await supabase.from("transactions").delete().eq("id", pending.id);
      delete pendingCancellations[user.telephone];
      return "Transaction supprimee avec succes.";
    }
  }

  if (extracted.type === "refuser") {
    delete pendingCancellations[user.telephone];
    return "Suppression annulee. Transaction conservee.";
  }

  if (extracted.type === "changer_numero") {
    pendingNumberChange[telephone] = { step: "ancien_numero" };
    const prefixe = telephone.replace("whatsapp:", "").substring(0, 4);
    const exemple = prefixe + "XXXXXXXX";
    return "Pour transferer votre compte, entrez votre ancien numero de telephone (avec indicatif, ex: " + exemple + ") :";
  }

  if (extracted.type === "pin_oublie") {
    if (!user.question_secrete) {
      return "Tu n as pas de question secrete configuree. Contacte le support.";
    }
    pendingPinRecovery[telephone] = {
      step: "reponse",
      pin: user.pin,
      question: user.question_secrete,
      reponse_secrete: user.reponse_secrete,
      tentatives: 0
    };
    return "Question secrete : " + user.question_secrete + "\n\nQuelle est ta reponse ?";
  }

  if (extracted.type === "mode_perso") {
    await supabase.from("utilisateurs").update({ mode_actif: "perso" }).eq("telephone", telephone);
    return "🏠 Mode personnel active.\n\nTes prochaines entrees seront enregistrees comme depenses personnelles.\n\nTape \"aide\" pour voir les commandes disponibles.";
  }

  if (extracted.type === "mode_business") {
    await supabase.from("utilisateurs").update({ mode_actif: "business" }).eq("telephone", telephone);
    return "Mode business active. Tes prochaines entrees seront enregistrees comme transactions professionnelles.\n\nTape \"mode perso\" pour passer au mode personnel.";
  }

  if (extracted.type === "voir_mode") {
    const mode = user.mode_actif || "business";
    return "Mode actif : " + (mode === "perso" ? "Personnel" : "Business") + "\n\nTape \"mode perso\" ou \"mode business\" pour changer.";
  }

  if (extracted.type === "budget_definir") {
    if (extracted.montant) {
      await supabase.from("utilisateurs").update({ budget_mensuel: extracted.montant }).eq("telephone", telephone);
      return "💰 Budget mensuel defini : " + extracted.montant.toLocaleString() + "\n\nJe te signalerai quand tu approches de la limite.";
    }
    // Pas de montant — afficher le budget actuel
    const budget = user.budget_mensuel;
    if (!budget) return "💰 Aucun budget defini.\n\nTape \"aide\" pour voir comment definir ton budget.";
    return "💰 Ton budget mensuel : " + budget.toLocaleString() + "\n\nPour le modifier, tape budget suivi du nouveau montant.";
  }

  if (extracted.type === "budget_depense") {
    if (!extracted.montant) return "Montant manquant. Tape \"aide\" pour voir comment enregistrer une depense.";
    const categorie = extracted.categorie || "autre";
    const emojis = { loyer: "🏠", nourriture: "🛒", transport: "🚗", sante: "💊", factures: "💡", education: "🎓", vetements: "👕", loisirs: "🎉", autre: "📦" };
    const emoji = emojis[categorie] || "📦";
    await supabase.from("transactions").insert({
      utilisateur_id: user.id,
      type: "depense",
      montant: extracted.montant,
      description: extracted.description || categorie,
      categorie: categorie
    });
    const confirmation = emoji + " Depense perso enregistree :\n" + categorie.charAt(0).toUpperCase() + categorie.slice(1) + " : " + extracted.montant.toLocaleString() + (extracted.description ? " - " + extracted.description : "") + "\nCategorie : " + categorie;

    // Alerte budget si defini
    if (user.budget_mensuel) {
      const debutMois = new Date();
      debutMois.setDate(1);
      debutMois.setHours(0, 0, 0, 0);
      const { data: txMois } = await supabase.from("transactions").select("montant").eq("utilisateur_id", user.id).not("categorie", "is", null).gte("created_at", debutMois.toISOString());
      const totalMois = (txMois || []).reduce((s, t) => s + t.montant, 0);
      const restant = user.budget_mensuel - totalMois;
      if (totalMois > user.budget_mensuel) {
        return confirmation + "\n\n\u26a0\ufe0f Budget depasse de " + Math.abs(restant).toLocaleString() + " !";
      } else if (totalMois >= user.budget_mensuel * 0.8) {
        return confirmation + "\n\n\u26a0\ufe0f Attention : " + restant.toLocaleString() + " restant sur ton budget.";
      }
    }
    return confirmation;
  }

  if (extracted.type === "inconnu") {
    return "Je n ai pas compris ta demande.\n\nTape \"aide\" pour voir la liste des commandes disponibles.";
  }

  if (extracted.type === "aide") {
    const mode = user.mode_actif || "business";
    if (mode === "perso") {
      return "🏠 COMMANDES MODE PERSONNEL\n\n" +
        "ENREGISTRER UNE DEPENSE :\n" +
        "Ecris simplement la categorie suivie du montant\n" +
        "Categories : loyer, nourriture, transport, sante, factures, education, vetements, loisirs\n\n" +
        "CONSULTER :\n" +
        "blj = Bilan du jour\n" +
        "blm = Bilan du mois\n" +
        "ht  = Historique (5 dernieres operations)\n\n" +
        "BUDGET :\n" +
        "budget = Definir ou voir ton budget mensuel\n\n" +
        "AUTRES :\n" +
        "mode business = Passer en mode Business\n" +
        "mon mode      = Voir le mode actif\n" +
        "annuler       = Annuler une operation\n" +
        "aide          = Afficher ce menu";
    }
    return "💼 COMMANDES MODE BUSINESS\n\n" +
      "ENREGISTRER :\n" +
      "vt = Vente (argent recu immediatement)\n" +
      "dp = Depense\n" +
      "cr = Credit client (argent a recevoir)\n" +
      "rb = Remboursement (client qui paie sa dette)\n" +
      "   vt si encaisse direct, cr si paie plus tard\n\n" +
      "CONSULTER :\n" +
      "blj = Bilan du jour\n" +
      "blm = Bilan du mois\n" +
      "lc  = Liste des credits en cours\n" +
      "ht  = Historique (5 dernieres operations)\n\n" +
      "AUTRES :\n" +
      "mode perso    = Passer en mode Personnel\n" +
      "mon mode      = Voir le mode actif\n" +
      "annuler       = Annuler une operation\n" +
      "pin oublie    = Recuperer ton PIN\n" +
      "changer numero = Transferer ton compte sur un nouveau numero\n" +
      "aide          = Afficher ce menu";
  }

  await saveTransaction(user.id, extracted);
  const deviseAffichee = extracted.devise ? " " + extracted.devise : "";
  return ("Enregistre : " + extracted.type + " de " + extracted.montant?.toLocaleString() + deviseAffichee + (extracted.description ? " - " + extracted.description : "") + (extracted.client ? " (client: " + extracted.client + ")" : "")).trim();
}
