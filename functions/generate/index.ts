import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.34.0";

serve(async (req) => {
  // CORS headers
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-goog-api-key,Authorization,apikey",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const title = url.searchParams.get("title") || "メインページ";

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const GENIMI_API_URL = Deno.env.get("GENIMI_API_URL") || "";
    const GENIMI_API_KEY = Deno.env.get("GENIMI_API_KEY") || "";

    if (!GENIMI_API_KEY || !GENIMI_API_URL) {
      console.error("GENIMI_API_URL or GENIMI_API_KEY is not set in function environment");
      return new Response(JSON.stringify({ error: "GENIMI_API_URL or GENIMI_API_KEY is not set in function environment" }), {
        status: 500,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) {
      console.error("Supabase service role key or URL missing in function environment");
      return new Response(JSON.stringify({ error: "Supabase SERVICE_ROLE_KEY or URL not configured" }), {
        status: 500,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 既存記事があれば返す
    const { data: existing } = await sb
      .from("articles")
      .select("*")
      .maybeSingle()
      .eq("title", title);

    if (existing) {
      return new Response(JSON.stringify(existing), {
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }

    // Genimi API に問い合わせて記事を生成
    const prompt = `以下のタイトルについて、日本語でWikipediaそっくりで、内容はすべて架空の記事をMarkdown形式（見出しは'## '）で作成してください。タイトル: ${title}\n\n簡潔に全体説明 → 見出し付きの数節を生成してください。`;

    const payload = {
      contents: [
        { parts: [{ text: prompt }] }
      ]
    };

    const oRes = await fetch(GENIMI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": GENIMI_API_KEY
      },
      body: JSON.stringify(payload),
    });

    if (!oRes.ok) {
      let errJson = null;
      try { errJson = await oRes.json(); } catch (e) { /* ignore */ }
      const errText = errJson || (await oRes.text());
      console.error("Genimi API error:", errText);

      // 標準的なエラーをそのまま返す
      return new Response(JSON.stringify({ error: errJson || String(errText) }), {
        status: 500,
        headers: { "content-type": "application/json", ...CORS_HEADERS }
      });
    }

    const ojson = await oRes.json();

    // Google Generative API の出力から本文を抽出する（複数形式に対応）
    let content = null;
    const extractors = [
      () => ojson.candidates?.[0]?.content?.[0]?.text,
      () => ojson.output?.[0]?.content?.[0]?.text,
      () => ojson.candidates?.[0]?.output?.[0]?.content?.[0]?.text,
      () => ojson.output?.[0]?.candidates?.[0]?.content?.[0]?.text,
      () => ojson.result?.outputs?.[0]?.content?.[0]?.text,
      () => ojson.output_text,
      () => ojson.text,
      () => ojson.contents?.[0]?.parts?.[0]?.text,
    ];

    for (const fn of extractors) {
      try {
        const v = fn();
        if (v && typeof v === 'string') {
          content = v.trim();
          break;
        }
        if (v) {
          content = typeof v === 'string' ? v.trim() : JSON.stringify(v);
          break;
        }
      } catch (e) { /* ignore */ }
    }

    if (!content) {
      const s = JSON.stringify(ojson);
      content = s.length > 8000 ? s.slice(0, 8000) : s;
    }

    // DB に保存
    await sb.from("articles").insert({ title, content });

    return new Response(JSON.stringify({ title, content }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(String(err), { status: 500, headers: CORS_HEADERS });
  }
});
