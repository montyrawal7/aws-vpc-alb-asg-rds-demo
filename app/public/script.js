const form = document.getElementById("reserve-form");
const statusBox = document.getElementById("reserve-status");
const submitBtn = document.getElementById("reserve-submit");

function showStatus(kind, message) {
  statusBox.className = kind; // "ok" or "err"
  statusBox.textContent = message;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  statusBox.className = "";
  statusBox.textContent = "";

  const payload = {
    name: document.getElementById("r-name").value.trim(),
    email: document.getElementById("r-email").value.trim(),
    phone: document.getElementById("r-phone").value.trim(),
    partySize: document.getElementById("r-party").value,
    date: document.getElementById("r-date").value,
    time: document.getElementById("r-time").value,
    notes: document.getElementById("r-notes").value.trim(),
  };

  if (!payload.name || !payload.email || !payload.phone || !payload.partySize || !payload.date || !payload.time) {
    showStatus("err", "Please fill in all required fields.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Requesting…";

  try {
    const res = await fetch("/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }

    showStatus(
      "ok",
      `You're booked, ${data.reservation.name.split(" ")[0]} — table for ${data.reservation.party_size} on ${data.reservation.reservation_date} at ${data.reservation.reservation_time}. We'll see you then.`
    );
    form.reset();
  } catch (err) {
    console.error("Reservation failed:", err);
    showStatus("err", err.message || "Something went wrong. Please try again or call us at (718) 849-0500.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Request Reservation";
  }
});
