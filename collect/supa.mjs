// Petit client REST Supabase pour les collecteurs (clé service, côté GitHub uniquement).
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || "";

export const supaReady = () => Boolean(URL_ && KEY);

export async function supa(path, { method = "GET", body, prefer, headers = {} } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} : ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
