import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Test : insérer un utilisateur
const { data, error } = await supabase
  .from("utilisateurs")
  .insert({ telephone: "+224612345678", nom: "Test Commerçant" })
  .select();

if (error) console.error("❌ Erreur:", error.message);
else console.log("✅ Utilisateur créé:", data);