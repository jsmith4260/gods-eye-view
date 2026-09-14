/** Hidden scene modes must release panel keyboard ownership and network work. */
export function observeCommunityMode(
  body,
  onHidden,
  Observer = MutationObserver,
) {
  let disposed = false;
  const sync = () => {
    if (
      !disposed &&
      ['cockpit-mode', 'recording-mode', 'ui-clean-view'].some((name) =>
        body.classList.contains(name),
      )
    )
      onHidden();
  };
  const observer = new Observer(sync);
  observer.observe(body, { attributes: true, attributeFilter: ['class'] });
  sync();
  return () => {
    disposed = true;
    observer.disconnect();
  };
}
