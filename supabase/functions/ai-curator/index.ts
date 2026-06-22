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
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const VANE_PROXY_URL = "https://kdqwiscohcxpsfzcfcyx.supabase.co/functions/v1/vane-proxy";

    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY nao configurada.");

    const { description } = await req.json();
    if (!description || typeof description !== "string") {
      return new Response(JSON.stringify({ error: "Campo description e obrigatorio." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 1. Gerar embedding da descricao do evento
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ input: description, model: "text-embedding-3-small" })
    });
    if (!embRes.ok) throw new Error("Falha ao gerar embedding.");
    const embData = await embRes.json();
    const queryEmbedding = embData.data[0].embedding;

    // 2. Busca semantica no pgvector para encontrar produtos relevantes
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: matchedProducts, error: matchError } = await supabase.rpc("match_produtos", {
      query_embedding: queryEmbedding,
      match_threshold: 0.1,
      match_count: 50
    });
    if (matchError) throw matchError;

    // 3. Buscar detalhes dos produtos encontrados no vane-proxy
    let contextCatalog = [];
    if (matchedProducts && matchedProducts.length > 0) {
      const ids = matchedProducts.map((m: { vane_id: number }) => m.vane_id).join(",");
      const proxyRes = await fetch(`${VANE_PROXY_URL}?ids=${ids}`);
      if (proxyRes.ok) {
        const products = await proxyRes.json();
        contextCatalog = products.map((p: Record<string, unknown>) => ({
          ...p,
          categoria: p.categoria || "Geral"
        }));
      }
    }

    if (contextCatalog.length === 0) {
      return new Response(JSON.stringify({ error: "Nenhum produto encontrado para este evento." }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 4. Curadoria via GPT-4o com contexto semanticamente filtrado
    const companyYears = new Date().getFullYear() - 1988;
    const systemPrompt = `Es um consultor de eventos de luxo da "Tempo de Festas" (${companyYears} anos de tradicao em BH).
Seleciona uma curadoria rica entre 6 a 12 produtos do catalogo abaixo (ja pre-filtrado por busca semantica).
RETORNA EXCLUSIVAMENTE JSON: {"sugestoes": [{"id": 1234, "motivo": "Explicacao curta e sofisticada"}]}.
O id deve ser exatamente igual ao id do catalogo, nunca invente IDs.
CATALOGO PRE-SELECIONADO: ${JSON.stringify(contextCatalog)}`;

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
    if (!chatRes.ok) throw new Error("Falha na curadoria IA.");

    const chatData = await chatRes.json();
    const parsed = JSON.parse(chatData.choices[0].message.content);
    const sugestoes = Array.isArray(parsed)
      ? parsed
      : (parsed.sugestoes || parsed.items || Object.values(parsed)[0]);

    return new Response(JSON.stringify({ sugestoes, contextCatalog }), {
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
