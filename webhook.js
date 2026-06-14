import express from "express";
import twilio from "twilio";
import { processMessage } from "./index.js";

const app = express();
app.use(express.urlencoded({ extended: false }));

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

app.listen(3000, () => console.log("✅ Serveur démarré sur port 3000"));