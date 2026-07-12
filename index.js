import OpenAI, { toFile } from "openai";
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
const pendingEmployeeJoin = {};
const pendingImageImport = {};

const SYSTEM_PROMPT = `Tu es un assistant comptable pour des commercants.
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
- "bilan trimestriel", "blt" = bilan, periode: trimestre
- "bilan semestriel", "bls" = bilan, periode: semestre
- "bilan annuel", "bla" = bilan, periode: annuel
- "blj", "bilan jour" = bilan, periode: jour
- "blm", "bilan mois" = bilan, periode: mois
- "qui me doit", "liste des credits", "mes credits", "liste credits", "lc" = credits_liste
- "aide", "help", "commandes", "?" = aide
- "annuler", "supprimer", "erreur", "annule" = annuler
- "oui", "yes", "confirmer" = confirmer
- "non", "no" = refuser
- "dernieres transactions", "historique", "mes transactions", "liste transactions", "ht" = historique
- "changer numero", "nouveau numero", "changer mon numero" = changer_numero
- "partenaire", "code partenaire", "ambassadeur" = partenaire
- "supprimer mon compte", "effacer mon compte", "delete account" = supprimer_compte
- "mon abo", "mon abonnement", "statut abo", "quand expire" = mon_abo
- "communaute", "groupe", "rejoindre communaute", "whatsapp group" = communaute
- "pin oublie", "oublie pin", "recuperer pin", "mot de passe oublie" = pin_oublie

Retourne ce JSON :
{
  "type": "vente" | "depense" | "credit" | "remboursement" | "bilan" | "credits_liste" | "historique" | "aide" | "annuler" | "confirmer" | "refuser" | "pin_oublie" | "changer_numero" | "partenaire" | "communaute" | "mon_abo" | "supprimer_compte" | "inconnu",
  "montant": number | null,
  "devise": string | null,
  "description": string | null,
  "client": string | null,
  "periode": "jour" | "mois" | "trimestre" | "semestre" | "annuel" | null
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

async function extractTransaction(message) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
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

const VISION_SYSTEM_PROMPT = `Tu es un assistant comptable. Tu recois une photo d'un cahier de comptes manuscrit ou d'une liste de transactions ecrites a la main ou imprimees.
Extrait CHAQUE ligne de transaction que tu peux lire clairement.

Pour chaque transaction, determine :
- type : "vente" (argent recu/encaisse), "depense" (argent depense), "credit" (vente a credit, le client doit de l argent), "remboursement" (client qui rembourse une dette existante)
- montant : nombre uniquement, sans texte ni devise
- description : bref texte decrivant l article/service si visible, sinon null
- client : nom du client si visible (surtout pour credit/remboursement), sinon null

Ignore les lignes illisibles, barrees ou ambigues plutot que de deviner au hasard.
Si aucune transaction n est identifiable avec certitude, retourne un tableau vide.

Retourne UNIQUEMENT ce JSON, sans aucun texte avant ou apres :
{
  "transactions": [
    { "type": "vente" | "depense" | "credit" | "remboursement", "montant": number, "description": string | null, "client": string | null }
  ]
}`;

async function extractTransactionsFromImage(mediaUrl, contentType) {
  const authHeader = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64");
  const imgResponse = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
  if (!imgResponse.ok) throw new Error("Impossible de telecharger l'image (" + imgResponse.status + ")");
  const arrayBuffer = await imgResponse.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const dataUrl = "data:" + contentType + ";base64," + base64;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Extrait toutes les transactions visibles sur cette photo de cahier de comptes." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
  });

  const raw = response.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Reponse OpenAI invalide (JSON malforme) : " + raw);
  }
  return Array.isArray(parsed.transactions) ? parsed.transactions : [];
}

async function transcribeAudio(mediaUrl, contentType) {
  const authHeader = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64");
  const audioResponse = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
  if (!audioResponse.ok) throw new Error("Impossible de telecharger l'audio (" + audioResponse.status + ")");
  const arrayBuffer = await audioResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = contentType.includes("ogg") ? "ogg" : contentType.includes("mpeg") ? "mp3" : "audio";
  const file = await toFile(buffer, "voice." + ext, { type: contentType });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "fr",
  });

  return transcription.text;
}

async function saveTransaction(userId, extracted, businessId, auteurNom) {
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
      business_id: businessId || null,
      auteur_nom: auteurNom || null,
    })
    .select();

  if (error) throw error;
  return data[0];
}

async function getBilan(userOrBusinessId, periode, isBusiness) {
  const from = new Date();
  if (periode === "mois") {
    from.setDate(1);
  } else if (periode === "trimestre") {
    const mois = from.getMonth();
    const debutTrimestre = Math.floor(mois / 3) * 3;
    from.setMonth(debutTrimestre);
    from.setDate(1);
  } else if (periode === "semestre") {
    const debutSemestre = from.getMonth() < 6 ? 0 : 6;
    from.setMonth(debutSemestre);
    from.setDate(1);
  } else if (periode === "annuel") {
    from.setMonth(0);
    from.setDate(1);
  }
  from.setHours(0, 0, 0, 0);

  let query = supabase.from("transactions").select("*").gte("created_at", from.toISOString());
  query = isBusiness ? query.eq("business_id", userOrBusinessId) : query.eq("utilisateur_id", userOrBusinessId);
  const { data, error } = await query;

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

async function getSoldeClient(userOrBusinessId, client, isBusiness) {
  let query = supabase.from("transactions").select("*").ilike("client", "%" + client + "%");
  query = isBusiness ? query.eq("business_id", userOrBusinessId) : query.eq("utilisateur_id", userOrBusinessId);
  const { data, error } = await query;

  if (error) throw error;
  const transactions = data || [];

  const credits = transactions.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
  const remboursements = transactions.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

  return credits - remboursements;
}

function getPrixAbonnement(telephone) {
  const tel = telephone.replace("whatsapp:", "");
  if (tel.startsWith("+224")) return { mensuel: "10 000 GNF", annuel: "100 000 GNF (2 mois offerts)", paiement: "Orange Money Guinee : +224 613 549 205" };
  const zoneFCFA = ["+237","+221","+225","+223","+226","+228","+229","+227","+222"];
  if (zoneFCFA.some(p => tel.startsWith(p))) return { mensuel: "2 000 FCFA", annuel: "20 000 FCFA (2 mois offerts)", paiement: "Orange Money Cameroun : +237 686 895 796" };
  return { mensuel: "4.99 USD", annuel: "49.90 USD (2 mois offerts)", paiement: "Revolut : https://revolut.me/martin2dvf" };
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

export async function processMessage(telephone, message, media) {
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
    "3. Le nom de ta ville natale ?"
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
    return "PIN confirme !\n\nChoisis une question secrete pour recuperer ton PIN :\n\n" + QUESTIONS_SECRETES.join("\n") + "\n\nReponds avec le numero (1 a 3) :";
  }

  if (pendingPins[telephone]?.step === "question") {
    const choix = parseInt(message.trim());
    if (isNaN(choix) || choix < 1 || choix > 3) {
      return "Choix invalide. Reponds avec un numero entre 1 et 3 :";
    }
    const questions = [
      "Le prenom de ta mere ?",
      "Le nom de ton ecole primaire ?",
      "Le nom de ta ville natale ?"
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

    const dateDebut = new Date();
    const dateFin = new Date();
    dateFin.setDate(dateFin.getDate() + 30);

    await supabase.from("abonnements").insert({
      utilisateur_id: user.id,
      tier: "gratuit",
      duree: "mensuel",
      date_debut: dateDebut.toISOString(),
      date_fin: dateFin.toISOString(),
      actif: true
    });

    pendingTutorial[telephone] = { step: 1 };

    const prix = getPrixAbonnement(telephone);
    return "Compte cree avec succes !\n\nBienvenue sur Bilan Pro, ton assistant comptable sur WhatsApp !\n\n30 jours d'essai gratuit. Profites-en pour tout tester !\n\nApres l'essai :\nAbonnement mensuel : " + prix.mensuel + "\nAbonnement annuel : " + prix.annuel + "\nPaiement : " + prix.paiement + "\nApres paiement, envoie ton recu a : support@bilanpro.app\n\nOn va faire un essai rapide ensemble.\n\nETAPE 1/4 — Tu fais une vente ?\nTape exactement : vt 1000 test";
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

  // Note vocale
  if (media && media.contentType && media.contentType.startsWith("audio/") && !pendingPins[telephone] && !pendingTutorial[telephone]) {
    if (tier === "expire") {
      const prix = getPrixAbonnement(telephone);
      return "⚠️ Ta periode d'essai est terminee.\n\nAbonnement mensuel : " + prix.mensuel + "\nAbonnement annuel : " + prix.annuel + "\n\nSouscris sur www.bilanpro.app";
    }
    try {
      const transcript = await transcribeAudio(media.url, media.contentType);
      console.log("Transcription vocale (" + telephone + ") : " + transcript);
      if (!transcript || !transcript.trim()) {
        return "Je n'ai pas compris ta note vocale.\n\nEssaie de reparler plus clairement dans un endroit calme, ou tape ton message.";
      }
      const reponse = await processMessage(telephone, transcript, null);
      return "🎤 J'ai compris : \"" + transcript.trim() + "\"\n\n" + reponse;
    } catch (err) {
      console.error("Erreur transcription audio:", err);
      return "Je n'ai pas reussi a transcrire ta note vocale. Reessaie ou tape ton message.";
    }
  }

  // Import photo cahier de comptes
  if (media && media.contentType && media.contentType.startsWith("image/") && !pendingPins[telephone] && !pendingTutorial[telephone]) {
    if (tier === "expire") {
      const prix = getPrixAbonnement(telephone);
      return "⚠️ Ta periode d'essai est terminee.\n\nAbonnement mensuel : " + prix.mensuel + "\nAbonnement annuel : " + prix.annuel + "\n\nSouscris sur www.bilanpro.app";
    }
    try {
      const items = await extractTransactionsFromImage(media.url, media.contentType);
      if (!items || items.length === 0) {
        return "Je n'ai trouve aucune transaction lisible sur cette photo.\n\nEssaie avec une photo plus nette et bien eclairee, ou enregistre tes transactions une par une (vt/dp/cr/rb).";
      }
      pendingImageImport[telephone] = { transactions: items };
      const liste = items.map((t, i) =>
        (i + 1) + ". " + (t.type || "?").toUpperCase() + " " + (t.montant?.toLocaleString() || "?") +
        (t.description ? " - " + t.description : "") +
        (t.client ? " (" + t.client + ")" : "")
      ).join("\n");
      return "J'ai trouve " + items.length + " transaction(s) sur ta photo :\n\n" + liste + "\n\nTu confirmes l'enregistrement ? Reponds OUI ou NON.";
    } catch (err) {
      console.error("Erreur extraction image:", err);
      return "Je n'ai pas reussi a analyser cette photo. Reessaie avec une photo plus nette, ou enregistre tes transactions une par une.";
    }
  }

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
        return "✅ Enregistre : vente de 1,000 - test\n\nC'est comme ca que tu enregistreras tes vraies ventes !\n\nETAPE 2/4 — Tu as une depense ?\nTape exactement : dp 500 test";
      }
      return "Pour continuer, tape exactement :\nvt 1000 test\n\n(tape \"stop\" pour arreter le tutoriel)";
    }

    if (step === 2) {
      if (texte === "stop") { delete pendingTutorial[telephone]; return "Tutoriel arrete. Tape \"aide\" pour voir les commandes."; }
      if (texte === "dp 500 test") {
        await saveTransaction(user.id, { type: "depense", montant: 500, description: "test" });
        pendingTutorial[telephone].step = 3;
        return "✅ Enregistre : depense de 500 - test\n\nETAPE 3/4 — Un client achete a credit ?\nTape exactement : cr Test 2000";
      }
      return "Pour continuer, tape exactement :\ndp 500 test\n\n(ou \"stop\" pour arreter)";
    }

    if (step === 3) {
      if (texte === "stop") { delete pendingTutorial[telephone]; return "Tutoriel arrete. Tape \"aide\" pour voir les commandes."; }
      if (texte === "cr test 2000") {
        await saveTransaction(user.id, { type: "credit", montant: 2000, client: "Test" });
        pendingTutorial[telephone].step = 4;
        return "✅ Enregistre : credit de 2,000 (client: Test)\n\n💡 La difference entre vt et cr :\nvt = vente encaissee immediatement\ncr = vente a credit (compte dans le benefice quand le client rembourse avec rb)\n\nETAPE 4/4 — Tape exactement : blj";
      }
      return "Pour continuer, tape exactement :\ncr Test 2000\n\n(ou \"stop\" pour arreter)";
    }

    if (step === 4) {
      if (texte === "stop") { delete pendingTutorial[telephone]; return "Tutoriel arrete. Tape \"aide\" pour voir les commandes."; }
      if (texte === "blj") {
        delete pendingTutorial[telephone];
        const bilan = await getBilan(user.id, "jour");
        return "Bilan du jour :\nVentes : " + bilan.ventes.toLocaleString() + "\nDepenses : " + bilan.depenses.toLocaleString() + "\nBenefice : " + bilan.benefice.toLocaleString() + "\nCredits accordes : " + bilan.credits.toLocaleString() +
          "\n\n🎉 Bravo, tu connais l'essentiel !\n\nTape \"aide\" a tout moment pour revoir les commandes.";
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

    await supabase.from("transactions")
      .update({ utilisateur_id: user.id })
      .eq("utilisateur_id", ancienUser.id);

    await supabase.from("utilisateurs")
      .update({
        pin: ancienUser.pin,
        pin_confirme: true,
        question_secrete: ancienUser.question_secrete,
        reponse_secrete: ancienUser.reponse_secrete
      })
      .eq("telephone", telephone);

    await supabase.from("utilisateurs").delete().eq("id", ancienUser.id);
    delete pendingNumberChange[telephone];
    return "✅ Compte transfere avec succes !\n\nToutes vos transactions ont ete transferees vers ce nouveau numero.";
  }

  if (pendingEmployeeJoin[telephone]) {
    const prenom = message.trim();
    if (!prenom) return "Prenom invalide. Quel est ton prenom ?";
    await supabase.from("utilisateurs").update({ business_id: pendingEmployeeJoin[telephone].businessId, role: "employe", nom: prenom }).eq("id", user.id);
    delete pendingEmployeeJoin[telephone];
    return "Tu as rejoint le business avec succes, " + prenom + " !\n\nTes transactions (vt/dp/cr/rb) seront visibles par ton patron.\n\nTape 'aide' pour voir les commandes.";
  }

  if (pendingImageImport[telephone]) {
    const reponse = message.trim().toLowerCase();
    if (reponse === "oui" || reponse === "yes") {
      const items = pendingImageImport[telephone].transactions;
      for (const item of items) {
        await saveTransaction(user.id, item, user.business_id, user.nom);
      }
      delete pendingImageImport[telephone];
      return "✅ " + items.length + " transaction(s) enregistree(s) avec succes !";
    }
    if (reponse === "non" || reponse === "no") {
      delete pendingImageImport[telephone];
      return "Import annule. Aucune transaction enregistree.";
    }
    return "Reponds OUI pour confirmer l'enregistrement de ces transactions, ou NON pour annuler.";
  }

  const messageLower = message.trim().toLowerCase();

  if (messageLower === "mon code") {
    if (user.role === "employe") {
      return "Tu es deja employe d'un business. Contacte ton patron si besoin.";
    }
    if (user.business_id) {
      const { data: biz } = await supabase.from("business").select("code").eq("id", user.business_id).single();
      return "Ton code business : " + biz.code + "\n\nPartage ce code a tes employes. Ils doivent taper exactement :\nrejoindre " + biz.code;
    }
    const code = "BP-" + Math.random().toString(36).substring(2, 6).toUpperCase();
    const { data: newBiz, error: bizError } = await supabase.from("business").insert({ code, patron_id: user.id }).select().single();
    if (bizError) throw bizError;
    await supabase.from("utilisateurs").update({ business_id: newBiz.id, role: "patron" }).eq("id", user.id);
    return "Business cree !\n\nTon code : " + code + "\n\nPartage ce code a tes employes. Ils doivent taper exactement :\nrejoindre " + code + "\n\nToutes leurs transactions apparaitront dans ton bilan.";
  }

  if (messageLower.startsWith("rejoindre ") && messageLower !== "rejoindre communaute") {
    const code = message.trim().split(/\s+/)[1]?.toUpperCase();
    if (!code) return "Format invalide. Tape : rejoindre CODE";
    const { data: biz } = await supabase.from("business").select("*").eq("code", code).single();
    if (!biz) return "Code invalide. Verifie le code aupres de ton patron.";
    pendingEmployeeJoin[telephone] = { businessId: biz.id };
    return "Business trouve !\n\nQuel est ton prenom ? (pour que ton patron sache qui a fait quoi)";
  }

  const extracted = await extractTransaction(message);

  // Restrictions apres expiration
  if (tier === "expire") {
    const prix = getPrixAbonnement(telephone);
    const debutMois = new Date(); debutMois.setDate(1); debutMois.setHours(0,0,0,0);
    const { count } = await supabase.from("transactions").select("*", { count: "exact", head: true }).eq("utilisateur_id", user.id).gte("created_at", debutMois.toISOString());
    if (count >= 10 && ["vente","depense","credit","remboursement"].includes(extracted.type)) {
      return "⚠️ Ta periode d'essai est terminee.\n\nPour continuer :\nAbonnement mensuel : " + prix.mensuel + "\nAbonnement annuel : " + prix.annuel + "\n\nPaiement : " + prix.paiement + "\n\nApres paiement, envoie ton recu a : support@bilanpro.app";
    }
    if (extracted.type === "historique") {
      return "⚠️ Ta periode d'essai est terminee.\n\nAbonnement mensuel : " + prix.mensuel + "\nAbonnement annuel : " + prix.annuel + "\n\nSouscris sur www.bilanpro.app";
    }
  }

  if (tier === "pro") {
    // Pas de restrictions specifiques pour le moment
  }

  if (["bilan", "historique", "credits_liste", "annuler", "mon_abo"].includes(extracted.type) && user.role === "employe") {
    return "Seul le patron peut consulter le bilan, l'historique ou les credits.\n\nTu peux enregistrer des transactions avec vt / dp / cr / rb.";
  }

  if (extracted.type === "bilan") {
    if (extracted.client) {
      const solde = await getSoldeClient(user.business_id || user.id, extracted.client, !!user.business_id);
      return "Solde de " + extracted.client + " :\n" + (solde > 0 ? "Doit encore : " + solde.toLocaleString() + " " + (extracted.devise || "") : "Aucune dette en cours.");
    }

    const bilan = await getBilan(user.business_id || user.id, extracted.periode || "jour", !!user.business_id);
    const devise = extracted.devise || "";
    const periodeLabel = {
      jour: "du jour",
      mois: "du mois",
      trimestre: "du trimestre",
      semestre: "du semestre",
      annuel: "de l annee"
    }[extracted.periode || "jour"] || "du jour";
    return "Bilan " + periodeLabel + " :\n" +
      "Ventes : " + bilan.ventes.toLocaleString() + " " + devise + "\n" +
      "Depenses : " + bilan.depenses.toLocaleString() + " " + devise + "\n" +
      "Benefice : " + bilan.benefice.toLocaleString() + " " + devise + "\n" +
      "Credits accordes : " + bilan.credits.toLocaleString() + " " + devise;
  }

  if (extracted.type === "historique") {
    let histQuery = supabase.from("transactions").select("*").order("created_at", { ascending: false }).limit(5);
    histQuery = user.business_id ? histQuery.eq("business_id", user.business_id) : histQuery.eq("utilisateur_id", user.id);
    const { data } = await histQuery;

    if (!data || data.length === 0) return "Aucune transaction enregistree.";

    const emojis = { vente: "✅", depense: "💸", credit: "📋", remboursement: "💰" };
    const liste = data.map((t) =>
      (emojis[t.type] || "•") + " " + t.type.toUpperCase() + " " + t.montant?.toLocaleString() +
      (t.description ? " - " + t.description : "") +
      (t.client ? " (" + t.client + ")" : "") +
      (t.auteur_nom ? " [" + t.auteur_nom + "]" : "") +
      " | " + new Date(t.created_at).toLocaleDateString("fr-FR")
    ).join("\n");

    return "5 dernieres transactions :\n\n" + liste;
  }

  if (extracted.type === "credits_liste") {
    let credQuery = supabase.from("transactions").select("*").in("type", ["credit", "remboursement"]);
    credQuery = user.business_id ? credQuery.eq("business_id", user.business_id) : credQuery.eq("utilisateur_id", user.id);
    const { data, error } = await credQuery;

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

  if (extracted.type === "partenaire") {
    // Extraire le code du message
    const code = message.trim().toUpperCase().split(/\s+/).pop();
    if (!code || code === "PARTENAIRE" || code === "AMBASSADEUR") {
      return "Pour lier votre compte a un partenaire, envoyez :\npartenaire [CODE]\n\nExemple : partenaire BP-ALPHA";
    }

    const { data: partenaire } = await supabase
      .from("partenaires")
      .select("*")
      .eq("code", code)
      .eq("actif", true)
      .single();

    if (!partenaire) {
      return "Code partenaire invalide ou inactif. Verifie le code et reessaie.";
    }

    await supabase.from("utilisateurs")
      .update({ partenaire_code: code })
      .eq("telephone", telephone);

    return "✅ Compte lie au partenaire : " + partenaire.nom + "\n\nMerci ! Vous beneficiez maintenant de l'accompagnement de " + partenaire.nom + ".";
  }

  if (extracted.type === "supprimer_compte") {
    pendingCancellations[telephone] = { step: "supprimer_compte" };
    return "⚠️ Es-tu sur de vouloir supprimer ton compte ?\n\nToutes tes transactions et donnees seront effacees definitivement.\n\nReponds OUI pour confirmer ou NON pour annuler.";
  }

  if (pendingCancellations[telephone]?.step === "supprimer_compte") {
    if (message.trim().toLowerCase() === "oui") {
      await supabase.from("transactions").delete().eq("utilisateur_id", user.id);
      await supabase.from("abonnements").delete().eq("utilisateur_id", user.id);
      await supabase.from("utilisateurs").delete().eq("id", user.id);
      delete pendingCancellations[telephone];
      return "✅ Ton compte a ete supprime avec succes.\n\nToutes tes donnees ont ete effacees. Merci d'avoir utilise Bilan Pro.";
    } else {
      delete pendingCancellations[telephone];
      return "Suppression annulee. Ton compte est conserve.";
    }
  }

  if (extracted.type === "mon_abo") {
    const { data: abo } = await supabase
      .from("abonnements")
      .select("*")
      .eq("utilisateur_id", user.id)
      .single();

    if (!abo) return "Aucun abonnement trouve. Contacte-nous sur support@bilanpro.app.";

    const dateFin = abo.date_fin ? new Date(abo.date_fin).toLocaleDateString('fr-FR') : 'Illimite';
    const joursRestants = abo.date_fin ? Math.ceil((new Date(abo.date_fin) - new Date()) / (1000 * 60 * 60 * 24)) : null;
    const statut = !abo.actif ? 'Expire' : joursRestants !== null && joursRestants <= 0 ? 'Expire' : abo.tier === 'gratuit' ? 'Essai gratuit' : 'Pro actif';
    const prix = getPrixAbonnement(telephone);

    let msg = "Mon abonnement Bilan Pro :\n\n";
    msg += "Statut : " + statut + "\n";
    msg += "Tier : " + (abo.tier === 'pro' ? 'Pro' : 'Gratuit (essai)') + "\n";
    msg += "Expire le : " + dateFin + "\n";
    if (joursRestants !== null && joursRestants > 0) msg += "Jours restants : " + joursRestants + "\n";
    if (statut === 'Essai gratuit' || statut === 'Expire') {
      msg += "\nPour souscrire :\nMensuel : " + prix.mensuel + "\nAnnuel : " + prix.annuel + "\nPaiement : " + prix.paiement + "\n\nApres paiement : support@bilanpro.app";
    }
    return msg;
  }

  if (extracted.type === "communaute") {
    return "👥 Rejoins la communauté Bilan Pro sur WhatsApp !\n\nSupport, annonces, témoignages et conseils entre utilisateurs.\n\nhttps://chat.whatsapp.com/BYEt3wElWQ0ErbkWdzWlri";
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

  if (extracted.type === "inconnu") {
    return "Je n ai pas compris ta demande.\n\nTape \"aide\" pour voir la liste des commandes disponibles.";
  }

  if (extracted.type === "aide") {
    return "💼 COMMANDES BILAN PRO\n\n" +
      "ENREGISTRER :\n" +
      "vt = Vente (argent recu immediatement)\n" +
      "dp = Depense\n" +
      "cr = Credit client (argent a recevoir)\n" +
      "rb = Remboursement (client qui paie sa dette)\n" +
      "   vt si encaisse direct, cr si paie plus tard\n" +
      "📷 Envoie une photo de ton cahier de comptes pour enregistrer plusieurs transactions d'un coup\n" +
      "🎤 Envoie une note vocale pour enregistrer une transaction en parlant\n\n" +
      "CONSULTER :\n" +
      "blj = Bilan du jour\n" +
      "blm = Bilan du mois\n" +
      "blt = Bilan du trimestre\n" +
      "bls = Bilan du semestre\n" +
      "bla = Bilan de l annee\n" +
      "lc  = Liste des credits en cours\n" +
      "ht  = Historique (5 dernieres operations)\n\n" +
      "AUTRES :\n" +
      "annuler        = Annuler une operation\n" +
      "mon abo        = Voir mon abonnement\n" +
      "mon code       = Creer/voir ton code business (equipe)\n" +
      "rejoindre CODE = Rejoindre le business d'un patron\n" +
      "pin oublie     = Recuperer ton PIN\n" +
      "changer numero = Transferer ton compte\n" +
      "communaute     = Rejoindre la communaute WhatsApp\n" +
      "aide           = Afficher ce menu";
  }

  await saveTransaction(user.id, extracted, user.business_id, user.nom);
  const deviseAffichee = extracted.devise ? " " + extracted.devise : "";
  return ("✅ Enregistre : " + extracted.type + " de " + extracted.montant?.toLocaleString() + deviseAffichee + (extracted.description ? " - " + extracted.description : "") + (extracted.client ? " (client: " + extracted.client + ")" : "")).trim();
}
