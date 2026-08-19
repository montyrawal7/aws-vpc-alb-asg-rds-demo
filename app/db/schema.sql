-- Run once against the RDS instance to set up the reservations table.

CREATE TABLE IF NOT EXISTS reservations (
    id                SERIAL PRIMARY KEY,
    name              VARCHAR(120)  NOT NULL,
    email             VARCHAR(255)  NOT NULL,
    phone             VARCHAR(30)   NOT NULL,
    party_size        INTEGER       NOT NULL CHECK (party_size BETWEEN 1 AND 20),
    reservation_date  DATE          NOT NULL,
    reservation_time  TIME          NOT NULL,
    notes             TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations (reservation_date);
