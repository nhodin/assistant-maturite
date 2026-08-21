/**
 * Manual correction of one criterion on one captured page.
 *
 * The verdict is sent to the run route, which re-scores the page and rebuilds
 * the site aggregate; the page is then reloaded so every derived number (topic
 * score, Global, GEO, China, site column) comes from the server rather than
 * being patched in the DOM. Corrections are transient by design — recapturing
 * the page recomputes it from the evidence and drops them.
 */
async function critEdit(el, runId, runPageId, controlId, verdict) {
  const previous = el.dataset.current || "";
  el.disabled = true;
  try {
    const res = await fetch(
      "/runs/" + runId + "/pages/" + runPageId + "/criteria/" + encodeURIComponent(controlId),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "verdict=" + encodeURIComponent(verdict),
      },
    );
    if (!res.ok) {
      window.alert("Correction impossible : " + (await res.text()));
      el.value = previous; // put the control back on the verdict still stored
      el.disabled = false;
      return;
    }
    window.location.reload();
  } catch (err) {
    window.alert("Correction impossible : " + err);
    el.value = previous;
    el.disabled = false;
  }
}
