/* Records where the last right-click landed.

   chrome.contextMenus.onClicked tells us which item was picked but not where
   the pointer was, and by the time the menu is clicked the contextmenu event is
   long gone. So a tiny always-on listener remembers the position for us. This
   is the only reason Vox ever asks for broad host access, it is optional, and
   it stores nothing but a pair of viewport coordinates. */
(() => {
  if (window.__VOX_ANCHOR_LOADED__) return;
  window.__VOX_ANCHOR_LOADED__ = true;

  document.addEventListener(
    "contextmenu",
    (event) => {
      window.__VOX_ANCHOR__ = { x: event.clientX, y: event.clientY, at: Date.now() };
    },
    true,
  );
})();
