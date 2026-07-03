import express from "express";
import twilio from "twilio";
import cron from "node-cron";
import { createClient } from "@supabase/supabase-js";
import { processMessage } from "./index.js";
import ws from "ws";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Resend } from "resend";

const __dirname = dirname(fileURLToPath(import.meta.url));
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.use(express.json());
app.use("/images", express.static(join(__dirname, "images")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: ws } }
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_FROM = "whatsapp:+15344449308";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "bilanpro2026";

// Prix par zone
function getPrixAbonnement(telephone) {
  const tel = telephone.replace("whatsapp:", "");
  if (tel.startsWith("+224")) return { mensuel: "10 000 GNF", annuel: "100 000 GNF (2 mois offerts)", devise: "GNF" };
  const zoneFCFA = ["+237","+221","+225","+223","+226","+228","+229","+227","+222"];
  if (zoneFCFA.some(p => tel.startsWith(p))) return { mensuel: "2 000 FCFA", annuel: "20 000 FCFA (2 mois offerts)", devise: "FCFA" };
  return { mensuel: "3 USD", annuel: "30 USD (2 mois offerts)", devise: "USD" };
}

app.get("/admin", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Acces non autorise");
  }
  const credentials = Buffer.from(auth.split(" ")[1], "base64").toString();
  const [, password] = credentials.split(":");
  if (password !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Mot de passe incorrect");
  }
  res.sendFile(join(__dirname, "dashboard.html"));
});

app.get("/admin/data", (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    return res.status(401).json({ error: "Non autorise" });
  }
  const credentials = Buffer.from(auth.split(" ")[1], "base64").toString();
  const [, password] = credentials.split(":");
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Mot de passe incorrect" });
  }
  next();
});

// Landing page
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "landing.html"));
});

app.get("/guide", (req, res) => {
  res.sendFile(join(__dirname, "guide.html"));
});

app.get("/manifest.json", (req, res) => {
  res.sendFile(join(__dirname, "manifest.json"));
});

app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(join(__dirname, "sw.js"));
});

app.get("/admin/data", async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: users } = await supabase.from("utilisateurs").select("*");
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*, utilisateurs(telephone)")
    .order("created_at", { ascending: false })
    .limit(50);

  const transactionsToday = (transactions || []).filter(t => new Date(t.created_at) >= today);
  const ventesToday = transactionsToday
    .filter(t => t.type === "vente")
    .reduce((s, t) => s + t.montant, 0);

  const creditsEnCours = (transactions || [])
    .filter(t => t.type === "credit")
    .reduce((s, t) => s + t.montant, 0) -
    (transactions || [])
    .filter(t => t.type === "remboursement")
    .reduce((s, t) => s + t.montant, 0);

  const formatted = (transactions || []).map(t => ({
    ...t,
    telephone: t.utilisateurs?.telephone || "-"
  }));

  const PAYS = {
    "+224": "Guinée",
    "+237": "Cameroun",
    "+221": "Sénégal",
    "+225": "Côte d'Ivoire",
    "+223": "Mali",
    "+226": "Burkina Faso",
    "+228": "Togo",
    "+229": "Bénin",
    "+227": "Niger",
    "+222": "Mauritanie",
    "+41": "Suisse",
    "+33": "France",
    "+32": "Belgique",
    "+1": "USA/Canada"
  };

  const parPays = {};
  for (const user of (users || [])) {
    const tel = user.telephone.replace("whatsapp:", "");
    let pays = "Autre";
    for (const [prefix, nom] of Object.entries(PAYS)) {
      if (tel.startsWith(prefix)) { pays = nom; break; }
    }
    parPays[pays] = (parPays[pays] || 0) + 1;
  }

  const usersWithDates = (users || [])
    .filter(u => u.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const inscriptions = usersWithDates.reduce((acc, user, i) => {
    const date = new Date(user.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    acc.push({ date, cumul: i + 1 });
    return acc;
  }, []);

  res.json({
    stats: {
      users: (users || []).length,
      transactionsToday: transactionsToday.length,
      ventesToday,
      creditsEnCours
    },
    transactions: formatted,
    inscriptions,
    parPays
  });
});

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const message = req.body.Body;
  const telephone = req.body.From;

  try {
    const reponse = await processMessage(telephone, message);
    twiml.message(reponse);
  } catch (err) {
    console.error(err);
    twiml.message("Erreur technique, reessaie.");
  }

  res.type("text/xml").send(twiml.toString());
});

// Rappels abonnement expirant -- chaque jour a 9h
cron.schedule("0 9 * * *", async () => {
  console.log("Verification abonnements expirants...");

  const maintenant = new Date();

  // Fonction pour trouver les abonnements expirant dans X jours
  async function rappelDans(jours, message) {
    const dateDebut = new Date(maintenant);
    dateDebut.setDate(dateDebut.getDate() + jours);
    dateDebut.setHours(0, 0, 0, 0);
    const dateFin = new Date(dateDebut);
    dateFin.setHours(23, 59, 59, 999);

    const { data } = await supabase
      .from("abonnements")
      .select("*, utilisateurs(telephone)")
      .eq("actif", true)
      .eq("tier", "gratuit")
      .gte("date_fin", dateDebut.toISOString())
      .lte("date_fin", dateFin.toISOString());

    for (const abo of (data || [])) {
      const tel = abo.utilisateurs?.telephone;
      if (!tel) continue;
      const prix = getPrixAbonnement(tel);
      const texte = message
        .replace("{JOURS}", jours)
        .replace("{MENSUEL}", prix.mensuel)
        .replace("{ANNUEL}", prix.annuel);
      try {
        await twilioClient.messages.create({ from: TWILIO_FROM, to: tel, body: texte });
        console.log("Rappel J-" + jours + " envoye a " + tel);
      } catch (err) {
        console.error("Erreur rappel J-" + jours + " " + tel + ":", err.message);
      }
    }
  }

  const msgRappel = "Votre periode d'essai Bilan Pro expire dans {JOURS} jour(s).\n\nPour continuer a gerer votre business sans interruption :\n\nAbonnement mensuel : {MENSUEL}\nAbonnement annuel : {ANNUEL}\n\nContactez-nous sur www.bilanpro.app pour souscrire.";
  const msgUrgent = "DERNIER JOUR ! Votre periode d'essai Bilan Pro expire aujourd'hui.\n\nVos donnees sont conservees. Pour continuer :\n\nAbonnement mensuel : {MENSUEL}\nAbonnement annuel : {ANNUEL}\n\nSouscrivez sur www.bilanpro.app";

  await rappelDans(5, msgRappel);
  await rappelDans(3, msgRappel);
  await rappelDans(2, msgRappel);
  await rappelDans(1, msgUrgent);

  // Abonnements expires aujourd'hui
  const debut = new Date(); debut.setHours(0, 0, 0, 0);
  const fin = new Date(); fin.setHours(23, 59, 59, 999);

  const { data: expiresAujourdhui } = await supabase
    .from("abonnements")
    .select("*, utilisateurs(telephone)")
    .eq("actif", true)
    .gte("date_fin", debut.toISOString())
    .lte("date_fin", fin.toISOString());

  for (const abo of (expiresAujourdhui || [])) {
    const tel = abo.utilisateurs?.telephone;
    if (!tel) continue;
    await supabase.from("abonnements").update({ actif: false }).eq("id", abo.id);
    console.log("Abo expire pour " + tel);
  }
});

// Rappels credits -- chaque jour a 8h
cron.schedule("0 8 * * *", async () => {
  console.log("Lancement rappels credits...");

  const { data: utilisateurs } = await supabase
    .from("utilisateurs")
    .select("*");

  for (const user of (utilisateurs || [])) {
    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .in("type", ["credit", "remboursement"]);

    const soldes = {};
    const derniereDate = {};

    for (const t of (transactions || []).filter(t => t.client !== null)) {
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
      .map(([client, montant]) => "- " + client + " : " + montant.toLocaleString())
      .join("\n");

    const message = "Rappel credits non rembourses depuis 7 jours :\n" + liste + "\n\nPense a relancer tes clients !";

    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: user.telephone,
        body: message,
      });
      console.log("Rappel envoye a " + user.telephone);
    } catch (err) {
      console.error("Erreur envoi rappel a " + user.telephone + ":", err.message);
    }
  }
});

// Bilan hebdomadaire -- chaque lundi a 7h
cron.schedule("0 7 * * 1", async () => {
  console.log("Envoi bilans hebdomadaires...");

  const { data: utilisateurs } = await supabase
    .from("utilisateurs")
    .select("*");

  const maintenant = new Date();
  const debutSemaine = new Date();
  debutSemaine.setDate(maintenant.getDate() - 7);
  debutSemaine.setHours(0, 0, 0, 0);

  for (const user of (utilisateurs || [])) {
    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .gte("created_at", debutSemaine.toISOString());

    if (!transactions || transactions.length === 0) continue;

    const ventes = transactions.filter(t => t.type === "vente").reduce((s, t) => s + t.montant, 0);
    const depenses = transactions.filter(t => t.type === "depense").reduce((s, t) => s + t.montant, 0);
    const credits = transactions.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
    const remboursements = transactions.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

    const message = "Bilan de la semaine :\n\nVentes : " + ventes.toLocaleString() + "\nDepenses : " + depenses.toLocaleString() + "\nBenefice : " + (ventes - depenses).toLocaleString() + "\nCredits accordes : " + credits.toLocaleString() + "\nRemboursements recus : " + remboursements.toLocaleString() + "\n\nBonne semaine !";

    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: user.telephone,
        body: message,
      });
      console.log("Bilan hebdo envoye a " + user.telephone);
    } catch (err) {
      console.error("Erreur bilan hebdo " + user.telephone + ":", err.message);
    }
  }
});

// Bilan mensuel -- 1er de chaque mois a 7h
cron.schedule("0 7 1 * *", async () => {
  console.log("Envoi bilans mensuels...");

  const { data: utilisateurs } = await supabase
    .from("utilisateurs")
    .select("*");

  const maintenant = new Date();
  const debutMois = new Date(maintenant.getFullYear(), maintenant.getMonth() - 1, 1);
  const debutMoisCourant = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);

  for (const user of (utilisateurs || [])) {
    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("utilisateur_id", user.id)
      .gte("created_at", debutMois.toISOString())
      .lt("created_at", debutMoisCourant.toISOString());

    if (!transactions || transactions.length === 0) continue;

    const ventes = transactions.filter(t => t.type === "vente").reduce((s, t) => s + t.montant, 0);
    const depenses = transactions.filter(t => t.type === "depense").reduce((s, t) => s + t.montant, 0);
    const credits = transactions.filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
    const remboursements = transactions.filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

    const moisNom = debutMois.toLocaleString("fr-FR", { month: "long", year: "numeric" });

    const message = "Bilan du mois de " + moisNom + " :\n\nVentes : " + ventes.toLocaleString() + "\nDepenses : " + depenses.toLocaleString() + "\nBenefice : " + (ventes - depenses).toLocaleString() + "\nCredits accordes : " + credits.toLocaleString() + "\nRemboursements recus : " + remboursements.toLocaleString() + "\nTransactions totales : " + transactions.length + "\n\nBon debut de mois !";

    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: user.telephone,
        body: message,
      });
      console.log("Bilan mensuel envoye a " + user.telephone);
    } catch (err) {
      console.error("Erreur bilan mensuel " + user.telephone + ":", err.message);
    }
  }
});

app.get("/admin/abonnements", async (req, res) => {
  const tier = req.query.tier;
  const statut = req.query.statut;

  let query = supabase
    .from("abonnements")
    .select("*, utilisateurs(telephone, nom)")
    .order("created_at", { ascending: false });

  if (tier) query = query.eq("tier", tier);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  let result = (data || []).map(a => ({
    utilisateur_id: a.utilisateur_id,
    nom: a.utilisateurs?.nom || "—",
    telephone: a.utilisateurs?.telephone || "—",
    tier: a.tier,
    duree: a.duree,
    date_debut: a.date_debut,
    date_fin: a.date_fin,
    actif: a.actif
  }));

  if (statut === "actif") result = result.filter(u => u.actif && (!u.date_fin || new Date(u.date_fin) > new Date()));
  if (statut === "expire") result = result.filter(u => !u.actif || (u.date_fin && new Date(u.date_fin) <= new Date()));

  res.json(result);
});

app.post("/admin/abonnements", async (req, res) => {
  const { utilisateur_id, tier, duree, date_debut, date_fin } = req.body;
  if (!utilisateur_id || !tier) return res.status(400).json({ error: "Champs manquants" });

  const { error } = await supabase
    .from("abonnements")
    .upsert({ utilisateur_id, tier, duree, date_debut, date_fin, actif: true }, { onConflict: "utilisateur_id" });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post("/admin/broadcast", async (req, res) => {
  const { message, tier, statut } = req.body;
  if (!message) return res.status(400).json({ error: "Message requis" });

  let utilisateurs;

  if (statut === "essai") {
    // Utilisateurs en periode d'essai active
    const { data: abos } = await supabase
      .from("abonnements")
      .select("utilisateur_id")
      .eq("tier", "gratuit")
      .eq("actif", true)
      .gt("date_fin", new Date().toISOString());
    const ids = (abos || []).map(a => a.utilisateur_id);
    if (ids.length === 0) return res.json({ success: 0, errors: 0, total: 0 });
    const { data } = await supabase.from("utilisateurs").select("telephone").in("id", ids);
    utilisateurs = data || [];
  } else if (statut === "expire") {
    // Utilisateurs avec abonnement expire
    const { data: abos } = await supabase
      .from("abonnements")
      .select("utilisateur_id")
      .eq("actif", false);
    const ids = (abos || []).map(a => a.utilisateur_id);
    if (ids.length === 0) return res.json({ success: 0, errors: 0, total: 0 });
    const { data } = await supabase.from("utilisateurs").select("telephone").in("id", ids);
    utilisateurs = data || [];
  } else if (tier && tier !== "tous") {
    const { data: abonnements } = await supabase
      .from("abonnements")
      .select("utilisateur_id")
      .eq("tier", tier)
      .eq("actif", true);
    const ids = (abonnements || []).map(a => a.utilisateur_id);
    if (ids.length === 0) return res.json({ success: 0, errors: 0, total: 0 });
    const { data } = await supabase.from("utilisateurs").select("telephone").in("id", ids);
    utilisateurs = data || [];
  } else {
    const { data } = await supabase.from("utilisateurs").select("telephone");
    utilisateurs = data || [];
  }

  let success = 0, errors = 0;
  for (const user of utilisateurs) {
    try {
      await twilioClient.messages.create({ from: TWILIO_FROM, to: user.telephone, body: message });
      success++;
    } catch (err) {
      console.error("Erreur broadcast " + user.telephone + ":", err.message);
      errors++;
    }
  }
  res.json({ success, errors, total: utilisateurs.length });
});

app.post("/contact", async (req, res) => {
  const { nom, tel, message } = req.body;
  if (!nom || !tel || !message) return res.status(400).json({ error: "Champs manquants" });

  await supabase.from("contacts").insert({ nom, telephone: tel, message });

  // Repondre immediatement sans attendre l'email
  res.json({ success: true });

  // Envoi email en arriere-plan via Resend
  resend.emails.send({
    from: "Bilan Pro <onboarding@resend.dev>",
    to: process.env.EMAIL_USER,
    subject: "Nouveau message Bilan Pro — " + nom,
    text: "Nom : " + nom + "\nContact : " + tel + "\n\nMessage :\n" + message
  }).then(() => {
    console.log("Email contact envoye pour " + nom);
  }).catch(err => {
    console.error("Erreur envoi email contact:", err.message);
  });
});

// Panel client
app.get("/client", (req, res) => {
  res.sendFile(join(__dirname, "client.html"));
});

app.post("/client/login", async (req, res) => {
  const { telephone, pin } = req.body;
  if (!telephone || !pin) return res.status(400).json({ error: "Champs manquants" });

  const { data: users } = await supabase
    .from("utilisateurs")
    .select("*")
    .eq("pin", pin);

  const user = (users || []).find(u =>
    u.telephone === telephone ||
    u.telephone === "whatsapp:" + telephone ||
    u.telephone.replace("whatsapp:", "") === telephone
  );

  if (!user) return res.status(401).json({ error: "Numero ou PIN incorrect." });

  res.json({ user: { id: user.id, telephone: user.telephone } });
});

app.get("/client/data", async (req, res) => {
  const userId = req.headers.authorization?.replace("Bearer ", "");
  if (!userId) return res.status(401).json({ error: "Non autorise" });

  const debutMois = new Date();
  debutMois.setDate(1);
  debutMois.setHours(0, 0, 0, 0);

  const { data: transactions } = await supabase
    .from("transactions")
    .select("*")
    .eq("utilisateur_id", userId)
    .order("created_at", { ascending: false });

  const mois = (transactions || []).filter(t => new Date(t.created_at) >= debutMois);
  const ventes = mois.filter(t => t.type === "vente").reduce((s, t) => s + t.montant, 0);
  const depenses = mois.filter(t => t.type === "depense").reduce((s, t) => s + t.montant, 0);
  const credits = (transactions || []).filter(t => t.type === "credit").reduce((s, t) => s + t.montant, 0);
  const remboursements = (transactions || []).filter(t => t.type === "remboursement").reduce((s, t) => s + t.montant, 0);

  res.json({
    stats: { ventes, depenses, benefice: ventes - depenses, credits: credits - remboursements },
    transactions: transactions || []
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Serveur demarre sur port " + PORT));
