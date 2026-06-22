import express from "express";
import twilio from "twilio";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { processMessage } from "./index.js";

const app = express();
app.use(express.urlencoded({ extended: false }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const message = req.body.Body;
  const telephone = req.body.From;

  try {
    const reponse = await processMessage(telephone, message);
    twiml.message(reponse);
  } catch (err) {
    console.error(err);
    twiml.message("Erreur technique, réessaie.");
  }

  res.type("text/xml").send(twiml.toString());
});

// Rappels crédits — chaque jour à 8h
cron.schedule("0 8 * * *", async () => {
  console.log("⏰ Lancement rappels crédits...");

  const { data: utilisateurs } = await supabase
    .from("utilisateurs")
    .select("*");

  for (const user of utilisateurs) {
    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .in("type", ["credit", "remboursement"]);

    const soldes = {};
    const derniereDate = {};

    for (const t of transactions) {
      if (!soldes[t.client]) {
        soldes[t.client] = 0;
        derniereDate[t.client] = t.created_at;
      }
      if (t.type === "credit") {
        soldes[t.client] += t.montant;
        if (t.created_at > derniereDate[t.client]) {
          derniereDate[t.client] = t.created_at;
        }
      }
      if (t.type === "remboursement") soldes[t.client] -= t.montant;
    }

    const maintenant = new Date();
    const debiteurs = Object.entries(soldes).filter(([client, montant]) => {
      if (montant <= 0) return false;
      const jours = (maintenant - new Date(derniereDate[client])) / (1000 * 60 * 60 * 24);
      return jours >= 7;
    });

    if (debiteurs.length === 0) continue;

    const liste = debiteurs
      .map(([client, montant]) => `• ${client} : ${montant.toLocaleString()} GNF`)
      .join("\n");

    const message = `⚠️ Rappel crédits non remboursés depuis 7 jours :\n${liste}\n\nPense à relancer tes clients !`;

    try {
      await twilioClient.messages.create({
        from: "whatsapp:+14155238886",
        to: user.telephone,
        body: message,
      });
      console.log(`✅ Rappel envoyé à ${user.telephone}`);
    } catch (err) {
      console.error(`❌ Erreur envoi rappel à ${user.telephone}:`, err.message);
    }
  }
});

app.listen(3000, () => console.log("✅ Serveur démarré sur port 3000"));