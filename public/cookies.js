document.addEventListener("DOMContentLoaded", () => {
  const acceptBtn = document.getElementById("accept-cookies");
  const declineBtn = document.getElementById("decline-cookies");
  const banner = document.getElementById("cookie-banner");

  if (acceptBtn) {
    acceptBtn.addEventListener("click", () => {
      localStorage.setItem("cookieConsent", "accepted");
      if (banner) banner.style.display = "none";
    });
  }

  if (declineBtn) {
    declineBtn.addEventListener("click", () => {
      localStorage.setItem("cookieConsent", "declined");
      if (banner) banner.style.display = "none";
    });
  }
});