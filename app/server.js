require("dotenv").config();
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// DB credential resolution
//
// Locally: DB_PASSWORD comes straight from .env.
// On EC2: DB_PASSWORD_PARAM is set instead (an SSM Parameter Store name), and
// the instance's IAM role is used to fetch + decrypt the real password at
// startup. Nothing sensitive ever lives in the AMI, user data, or env vars
// baked into the launch template.
// ---------------------------------------------------------------------------
async function resolveDbPassword() {
  if (process.env.DB_PASSWORD) {
    return process.env.DB_PASSWORD;
  }
  if (process.env.DB_PASSWORD_PARAM) {
    const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-2" });
    const result = await ssm.send(
      new GetParameterCommand({
        Name: process.env.DB_PASSWORD_PARAM,
        WithDecryption: true,
      })
    );
    return result.Parameter.Value;
  }
  throw new Error(
    "No DB credential configured — set DB_PASSWORD (local) or DB_PASSWORD_PARAM (EC2/SSM)."
  );
}

async function main() {
  const dbPassword = await resolveDbPassword();

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: dbPassword,
    max: 5,
    idleTimeoutMillis: 30000,
    // RDS requires SSL in transit; local Postgres for dev/testing typically
    // doesn't have SSL enabled, so this is opt-out via DB_SSL=false.
    ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Health check target for the ALB target group.
  app.get("/health", (req, res) => res.status(200).send("ok"));

  // Create a reservation.
  app.post("/api/reservations", async (req, res) => {
    const { name, email, phone, partySize, date, time, notes } = req.body || {};

    if (!name || !email || !phone || !partySize || !date || !time) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const size = Number(partySize);
    if (!Number.isInteger(size) || size < 1 || size > 20) {
      return res.status(400).json({ error: "Party size must be between 1 and 20." });
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const timePattern = /^\d{2}:\d{2}$/;
    if (!datePattern.test(date) || !timePattern.test(time)) {
      return res.status(400).json({ error: "Invalid date or time format." });
    }

    try {
      const result = await pool.query(
        `INSERT INTO reservations (name, email, phone, party_size, reservation_date, reservation_time, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, party_size, reservation_date, reservation_time`,
        [name.trim(), email.trim(), phone.trim(), size, date, time, notes ? String(notes).trim() : null]
      );
      return res.status(201).json({ reservation: result.rows[0] });
    } catch (err) {
      console.error("Failed to create reservation:", err);
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  // Public availability check: which time slots are already booked for a
  // given date. Deliberately returns only times, never names/emails/phones,
  // since this endpoint is unauthenticated.
  app.get("/api/reservations/availability", async (req, res) => {
    const { date } = req.query;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!date || !datePattern.test(date)) {
      return res.status(400).json({ error: "Provide a valid ?date=YYYY-MM-DD." });
    }
    try {
      const result = await pool.query(
        `SELECT reservation_time, COUNT(*)::int AS bookings
         FROM reservations
         WHERE reservation_date = $1
         GROUP BY reservation_time`,
        [date]
      );
      return res.json({ date, slots: result.rows });
    } catch (err) {
      console.error("Failed to fetch availability:", err);
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  app.listen(PORT, () => {
    console.log(`Spice Route Kitchen app listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
