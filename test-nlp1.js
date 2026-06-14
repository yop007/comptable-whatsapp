import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const client = new OpenAI();

const SYSTEM_PROMPT = `Tu es un assistant comptable pour des commerçants en Guinée.
Extrait les informations du message et retourne UNIQUEMENT un JSON valide.

Règles importantes :
- "elle a pris", "il a pris", "a pris de la marchandise" = credit
- "il a payé", "elle a payé", "a remboursé", "a payé" = remboursement
- "combien X me doit", "qu'est ce que X me doit" = bilan avec client renseigné
- Si le type est inconnu mais qu'il y a un montant, essaie de déduire le contexte

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

const MESSAGES_TEST = [
  "rien de spécial aujourd'hui",
  "combien Mamadou me doit ?",
  "vente vente vente 100000",
  "j'ai vendu pour environ 300000",
  "elle a pris de la marchandise 400000",
  "Mamadou il a payé 150000",
];

async function extractTransaction(message) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  const raw = response.choices[0].message.content;
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, raw };
  }
}

async function runTests() {
  console.log("=== TEST NLP EXTRACTION ===\n");
  let success = 0;
  let errors = 0;

  for (const msg of MESSAGES_TEST) {
    const result = await extractTransaction(msg);
    if (result.ok) {
      success++;
      const d = result.data;
      const status = d.type === "inconnu" ? "⚠️ " : "✅";
      console.log(`${status} "${msg}"`);
      console.log(
        `   → type:${d.type} | montant:${d.montant} | desc:${d.description} | client:${d.client}\n`
      );
    } else {
      errors++;
      console.log(`❌ "${msg}"`);
      console.log(`   → Parse error: ${result.raw}\n`);
    }
  }

  console.log(`\n=== RÉSULTATS ===`);
  console.log(`✅ Succès: ${success}/${MESSAGES_TEST.length}`);
  console.log(`❌ Erreurs: ${errors}/${MESSAGES_TEST.length}`);
  console.log(
    `📊 Précision: ${Math.round((success / MESSAGES_TEST.length) * 100)}%`
  );
}

runTests();