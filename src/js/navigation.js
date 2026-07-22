(function () {
  const buttons = Array.from(document.querySelectorAll("[data-section-target]"));
  const sections = Array.from(document.querySelectorAll(".workspace-section"));

  function openSection(sectionId, updateHash = true) {
    const target = document.getElementById(sectionId);
    if (!target) {
      return;
    }
    sections.forEach((section) => {
      const active = section.id === sectionId;
      section.hidden = !active;
      section.classList.toggle("active", active);
    });
    buttons.forEach((button) => {
      const active = button.dataset.sectionTarget === sectionId;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (updateHash) {
      history.replaceState(null, "", `#${sectionId}`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => openSection(button.dataset.sectionTarget));
  });

  window.addEventListener("navuryx:navigate", (event) => {
    openSection(event.detail && event.detail.section || "channels");
  });

  window.addEventListener("hashchange", () => {
    const sectionId = location.hash.slice(1);
    if (sections.some((section) => section.id === sectionId)) {
      openSection(sectionId, false);
    }
  });

  const initial = location.hash.slice(1);
  openSection(sections.some((section) => section.id === initial) ? initial : "channels", false);
}());
