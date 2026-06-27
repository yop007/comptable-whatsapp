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
- "qui me doit", "liste des credits", "mes credits", "liste credits", "lc" = credits_liste
- "aide", "help", "commandes", "?" = aide
- "annuler", "supprimer", "erreur", "annule" = annuler
- "oui", "yes", "confirmer" = confirmer
- "non", "no", "annuler" = refuser

Retourne ce JSON :
{
  "type": "vente" | "depense" | "credit" | "remboursement" | "bilan" | "credits_liste" | "aide" | "annuler" | "confirmer" | "refuser" | "inconnu",
  "montant": number | null,
  "devise": string | null,
  "description": string | null,
  "client": string | null,
  "periode": "jour" | "mois" | null
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

export async function processMessage(telephone, message) {
  const { user, isNew } = await getOrCreateUser(telephone);

  if (isNew) {
    pendingPins[telephone] = { step: "create" };
    return "Bienvenue sur Bilan WA !\n\nPour securiser ton compte, cree un code PIN a 4 chiffres.\nCe code te permettra de recuperer ton compte si tu changes de numero.\n\nEnvoie ton PIN a 4 chiffres :";
  }

  if (!user.pin_confirme && !pendingPins[telephone]) {
    pendingPins[telephone] = { step: "create" };
    return "Ton compte n a pas encore de PIN configure.\nEnvoie un code a 4 chiffres pour securiser ton compte :";
  }

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
    await supabase
      .from("utilisateurs")
      .update({ pin: message.trim(), pin_confirme: true })
      .eq("telephone", telephone);
    delete pendingPins[telephone];
    return "PIN cree avec succes !\n\nBienvenue sur Bilan WA !\nJe suis ton assistant comptable.\n\nEnvoie ton premier message pour commencer !";
  }

  const extracted = await extractTransaction(message);

  if (extracted.type === "bilan") {
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
      .map(([client, montant]) => "- " + client + " : " + montant.toLocaleString() + " GNF")
      .join("\n");

    return "Credits en cours :\n" + liste;
  }

  if (extracted.type === "annuler") {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    if (!data || data.length === 0) return "Aucune transaction a annuler.";

    const derniere = data[0];
    pendingCancellations[user.telephone] = derniere.id;

    return "Derniere operation enregistree :\n" +
      derniere.type.toUpperCase() + " de " + derniere.montant?.toLocaleString() +
      (derniere.description ? " - " + derniere.description : "") +
      (derniere.client ? " (client: " + derniere.client + ")" : "") +
      "\n\nConfirmer la suppression ? Reponds oui pour supprimer ou non pour annuler.";
  }

  if (extracted.type === "confirmer") {
    const transactionId = pendingCancellations[user.telephone];
    if (!transactionId) return "Aucune suppression en attente.";

    await supabase
      .from("transactions")
      .delete()
      .eq("id", transactionId);

    delete pendingCancellations[user.telephone];
    return "Transaction supprimee avec succes.";
  }

  if (extracted.type === "refuser") {
    delete pendingCancellations[user.telephone];
    return "Suppression annulee. Transaction conservee.";
  }

  if (extracted.type === "inconnu") {
    return "Je n ai pas compris. Exemples :\n- Vente 500000 GNF riz\n- Depense 100000 GNF transport\n- Credit Mamadou 300000 GNF";
  }

  if (extracted.type === "aide") {
    return "Commandes disponibles :\n\nVentes : Vente 500000 GNF riz\nDepenses : Depense 100000 GNF transport\nCredits : Credit Mamadou 300000 GNF\nRemboursements : Mamadou a paye 150000\nBilan : Bilan du jour / Bilan du mois\nListe credits : Qui me doit\nSolde client : Combien Mamadou me doit ?";
  }

  await saveTransaction(user.id, extracted);
  return ("Enregistre : " + extracted.type + " de " + extracted.montant?.toLocaleString() + " " + (extracted.devise || "") + (extracted.description ? " - " + extracted.description : "") + (extracted.client ? " (client: " + extracted.client + ")" : "")).trim();
}
