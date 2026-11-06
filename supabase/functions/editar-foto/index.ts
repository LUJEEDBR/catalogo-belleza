// Edita fotos de inventario con Gemini (solo uso interno con service_role).
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const b64 = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const PROMPT = `Edit the FIRST image (a real product photo) into a professional studio product photo. Use the SECOND image only as the style and scene reference: warm beige wall, clear acrylic blocks, dried golden leaves, soft natural key light, gentle shadow. Keep the product itself EXACTLY identical: same shape, same colors, same logo, and every printed word letter-for-letter unchanged; do not add, remove, translate or redraw any text; keep transparent liquids their original color. Remove hands, people and the original background. Product centered as the hero, upright, filling about 70% of a square frame. No extra products, no watermark.`;
Deno.serve(async (req) => {
  const auth = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!auth || auth !== Deno.env.get("EDITAR_TOKEN")) return J({ error: "no autorizado" }, 401);
  const key = Deno.env.get("GEMINI_API_KEY"); if (!key) return J({ error: "sin GEMINI_API_KEY" }, 500);
  const { nombre } = await req.json();
  const base = Deno.env.get("SUPABASE_URL") + "/storage/v1/object/public/fotos/respaldo/";
  const [o, e] = await Promise.all([fetch(base + "productos/" + nombre), fetch(base + "escena.jpg")]);
  if (!o.ok || !e.ok) return J({ error: "no encontré la foto", o: o.status, e: e.status }, 404);
  const mime = nombre.endsWith(".webp") ? "image/webp" : "image/jpeg";
  const body = { contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64(await o.arrayBuffer()) } }, { inline_data: { mime_type: "image/jpeg", data: b64(await e.arrayBuffer()) } }] }], generationConfig: { responseModalities: ["IMAGE"] } };
  let ult = "";
  for (const m of [Deno.env.get("GEMINI_IMAGE_MODEL"), "gemini-3.1-flash-lite-image", "gemini-nano-banana-2.1", "gemini-3.1-flash-image"].filter(Boolean)) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const p = d?.candidates?.[0]?.content?.parts?.find((x: any) => x.inlineData || x.inline_data);
    if (p) { const i = p.inlineData || p.inline_data; return J({ modelo: m, mime: i.mimeType || i.mime_type, data: i.data }); }
    ult = `${m}: ${r.status} ${JSON.stringify(d).slice(0, 200)}`;
  }
  return J({ error: ult }, 502);
});
