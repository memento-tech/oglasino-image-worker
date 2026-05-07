// HEAD /{key} — same auth as GET, headers only (§4.4). Implementation reuses
// the view module so HEAD/GET behavior cannot drift apart.

export { handleHead } from "./view.ts";
