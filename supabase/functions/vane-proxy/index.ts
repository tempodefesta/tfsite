import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import mysql from "npm:mysql2/promise";
import { Buffer } from "node:buffer";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '12');
    const offset = (page - 1) * limit;
    const fetchIds = url.searchParams.get('ids'); // comma separated ids for AI search

    // Retrieve SSL strings from Supabase Secrets and ensure escaped newlines are properly parsed
    const ca_cert = Deno.env.get('VANE_CA_CERT')?.replace(/\\n/g, '\n');
    const client_cert = Deno.env.get('VANE_CLIENT_CERT')?.replace(/\\n/g, '\n');
    const client_key = Deno.env.get('VANE_CLIENT_KEY')?.replace(/\\n/g, '\n');


    if (!ca_cert || !client_cert || !client_key) {
        throw new Error("Misconfigured MySQL SSL Secrets in Edge Function");
    }

    const connection = await mysql.createConnection({
        host: '3f98f2a8-3db7-4eaf-b053-8473bc5010e9.vanesistemas.com',
        user: 'vane_utempodefesta',
        password: 'chronos_tempodefestan@vane88', // This could also be a secret, keeping here for sync
        database: 'vane_tempodefesta',
        charset: 'latin1',
        ssl: {
            ca: ca_cert,
            key: client_key,
            cert: client_cert,
            rejectUnauthorized: false
        }
    });

    let results = [];
    if (fetchIds) {
        // IDs via AI semantic search
        const idsArray = fetchIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
        if (idsArray.length === 0) {
            return new Response(JSON.stringify([]), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const placeholders = idsArray.map(() => '?').join(',');
        const [rows] = await connection.execute(
            `SELECT CodigoDoProduto, Descricao, ValorLocacao, NomeDaImagem, Classe FROM produtos WHERE CodigoDoProduto IN (${placeholders}) AND Setor = 'CATÁLOGO'`,
            idsArray
        );
        results = rows;
    } else {
        // Normal Catalog Query
        const [rows] = await connection.execute(
            `SELECT CodigoDoProduto, Descricao, ValorLocacao, NomeDaImagem, Classe FROM produtos WHERE Ativo = 1 AND Setor = 'CATÁLOGO' AND NomeDaImagem IS NOT NULL AND NomeDaImagem != '' LIMIT ? OFFSET ?`,
            [String(limit), String(offset)] // Execute needs strings for limit/offset in mysql2 array
        );
        results = rows;
    }

    await connection.end();

    // Map output to build URLs and fix charsets
    const finalData = results.map((row: any) => ({
        id: row.CodigoDoProduto,
        nome: row.Descricao,
        preco: row.ValorLocacao,
        categoria: row.Classe,
        img_url: row.NomeDaImagem ? `https://fotos2.vanesistemas.com/app/arquivo_publico2/395/23894710000108/${row.NomeDaImagem}` : null
    }));

    return new Response(JSON.stringify(finalData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
