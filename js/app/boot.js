// Started last, once every other script has loaded: the data files' load and
// the sign-in state.

loadLastUpdated();

loadData().then(data => {
  DATA = data;
  renderChart('sigmoid');
  rendered.sigmoid = true;
  // If the user was already signed in before this finished loading,
  // mpUpdateAuthUi's earlier call to mpRenderPortfolioPies() bailed out
  // via the `if (!DATA) return` guard (DATA was still null at that point)
  // and never retried -- so retry it now that DATA is finally ready.
  if (mpIsSignedIn) mpRenderPortfolioPies();
}).catch(err => {
  document.body.insertAdjacentHTML('afterbegin',
    `<p style="color:#e05252">Failed to load data: ${err.message}</p>`);
  console.error(err);
});


// Redraw only when who's signed in actually changes: Supabase re-fires
// SIGNED_IN / TOKEN_REFRESHED whenever the tab regains focus (switching
// desktops / windows), which would reload every table and chart each time.
let mpAuthUserId;
function mpOnAuth(session) {
  const id = session?.user?.id ?? null;
  if (id === mpAuthUserId) return;
  mpAuthUserId = id;
  mpUpdateAuthUi(session);
}
sb.auth.getSession().then(({ data: { session } }) => mpOnAuth(session));
sb.auth.onAuthStateChange((_event, session) => mpOnAuth(session));
