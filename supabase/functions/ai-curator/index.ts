import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY nao configurada nos Secrets.");

    const { description, catalogContext } = await req.json();
    if (!description || typeof description !== "string") {
      return new Response(JSON.stringify({ error: "Campo description e obrigatorio." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 1. Gerar embedding da descricao
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ input: description, model: "text-embedding-3-small" })
    });
    if (!embRes.ok) {
      console.error("[ai-curator] embeddings error:", await embRes.text());
      throw new Error("Falha ao gerar embedding.");
    }
    const embData = await embRes.json();
    const queryEmbedding = embData.data[0].embedding;

    // 2. Busca semantica no Supabase pgvector
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    const { data: matchedProducts, error: matchError } = await supabase.rpc("match_produtos", {
      query_embedding: queryEmbedding,
      match_threshold: 0.1,
      match_count: 50
    });
    if (matchError) throw matchError;

    const context = catalogContext || matchedProducts || [];

    // 3. Curadoria via GPT-4o
    const companyYears = new Date().getFullYear() - 1988;
    const systemPrompt = `Es um consultor de eventos de luxo da "Tempo de Festas" (${companyYears} anos de tradicao em BH).
Seleciona uma curadoria rica entre 6 a 12 produtos do catalogo abaixo.
RETORNA EXCLUSIVAMENTE JSON: {"sugestoes": [{"id": 1234, "motivo": "Explicacao curta e sofisticada"}]}.
O id deve ser exatamente igual ao id do catalogo, nunca invente IDs.
CATALOGO: ${JSON.stringify(context)}`;

    const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: description }
        ],
        response_format: { type: "json_object" }
      })
    });
    if (!chatRes.ok) {
      console.error("[ai-curator] chat error:", await chatRes.text());
      throw new Error("Falha na curadoria IA.");
    }
    const chatData = await chatRes.json();
    const parsed = JSON.parse(chatData.choices[0].message.content);
    const sugestoes = Array.isArray(parsed)
      ? parsed
      : (parsed.sugestoes || parsed.items || Object.values(parsed)[0]);

    const matchedIds = (matchedProducts || []).map((m: { vane_id: number }) => m.vane_id);

    return new Response(JSON.stringify({ sugestoes, matchedIds }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("[ai-curator] error:", error);
    return new Response(
      JSON.stringify({ error: "Servico de curadoria temporariamente indisponivel." }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
