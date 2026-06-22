import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const SYSTEM_PROMPT = `Tu es un assistant comptable pour des commerçants en Guinée.
Extrait les informations du message et retourne UNIQUEMENT un JSON valide.

Règles importantes :
- "elle a pris", "il a pris", "a pris de la marchandise" = credit
- "il a payé", "elle a payé", "a remboursé", "a payé" = remboursement
- "combien X me doit", "qu'est ce que X me doit" = bilan avec client renseigné
- Si le type est inconnu mais qu'il y a un montant, essaie de déduire le contexte
- "quel est le bilan", "montre moi le bilan", "voir le bilan", "mon bilan" = bilan
- "combien X me doit", "qu'est ce que X me doit", "solde de X" = bilan avec client renseigné
- "bilan du jour", "bilan journalier", "bilan d'aujourd'hui" = bilan, periode: jour
- "bilan du mois", "bilan mensuel" = bilan, periode: mois
- "vt", "vente" = vente
- "dp", "dep", "dépense" = depense
- "cr", "crédit" = credit
- "rb", "remb" = remboursement
- "bl", "bilan" = bilan

Retourne ce JSON :
{
  "type": "vente" | "depense" | "credit" | "remboursement" | "bilan" | "inconnu",
  "montant": number | null,
  "devise": "GNF" | null,
  "description": string | null,
  "client": string | null,
  "periode": "jour" | "mois" | null
}
Aucun texte avant ou après le JSON.`;

async function getOrCreateUser(telephone) {
  let { data } = await supabase
    .from("utilisateurs")
    .select("*")
    .eq("telephone", telephone)
    .single();

  if (!data) {
    const { data: newUser } = await supabase
      .from("utilisateurs")
      .insert({ telephone })
      .select()
      .single();
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
  return JSON.parse(response.choices[0].message.content);
}

async function saveTransaction(userId, extracted) {
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
  const today = new Date();
  let from = new Date();
  if (periode === "mois") from.setDate(1);
  else from.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("transactions")
    .select("*")
    .eq("utilisateur_id", userId)
    .gte("created_at", from.toISOString());

  const ventes = data.filter(t => t.type === "vente").reduce((s, t) => s + t.montant, 0);
  const depenses = data.filter(t => t.type === "depense").reduce((s, t) => s + t.montant, 0);
  const credits = data.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
  const remboursements = data.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

  return { 
    ventes, 
    depenses, 
    benefice: ventes - depenses, 
    credits: credits - remboursements 
  };
}

async function getSoldeClient(userId, client) {
  const { data } = await supabase
    .from("transactions")
    .select("*")
    .eq("utilisateur_id", userId)
    .ilike("client", client);

  const credits = data.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
  const remboursements = data.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

  return credits - remboursements;
}

export async function processMessage(telephone, message) {
  const { user, isNew } = await getOrCreateUser(telephone);

if (isNew) {
  return `👋 Bienvenue sur Bilan WA !

Je suis ton assistant comptable. Voici ce que tu peux faire :

📦 *Enregistrer une vente*
→ "Vente 500000 GNF riz"

💸 *Enregistrer une dépense*
→ "Dépense 100000 GNF transport"

📋 *Enregistrer un crédit client*
→ "Crédit Mamadou 300000 GNF"

📊 *Voir ton bilan*
→ "Bilan du jour" ou "Bilan du mois"

Envoie ton premier message pour commencer !`;
}
  const extracted = await extractTransaction(message);

 if (extracted.type === "bilan") {
  if (extracted.client) {
    const solde = await getSoldeClient(user.id, extracted.client);
    return `📊 Solde de ${extracted.client} :
${solde > 0 ? `Doit encore : ${solde.toLocaleString()} GNF` : "Aucune dette en cours."}`;
  }

  const bilan = await getBilan(user.id, extracted.periode || "jour");
  return `📊 Bilan ${extracted.periode === "mois" ? "du mois" : "du jour"} :
✅ Ventes : ${bilan.ventes.toLocaleString()} GNF
💸 Dépenses : ${bilan.depenses.toLocaleString()} GNF
💰 Bénéfice : ${bilan.benefice.toLocaleString()} GNF
📋 Crédits accordés : ${bilan.credits.toLocaleString()} GNF`;
}

  if (extracted.type === "inconnu") {
    return "Je n'ai pas compris. Exemples :\n- Vente 500000 GNF riz\n- Dépense 100000 GNF transport\n- Crédit Mamadou 300000 GNF";
  }

  await saveTransaction(user.id, extracted);
  return `✅ Enregistré : ${extracted.type} de ${extracted.montant?.toLocaleString()} GNF${extracted.description ? " - " + extracted.description : ""}${extracted.client ? " (client: " + extracted.client + ")" : ""}`;
}