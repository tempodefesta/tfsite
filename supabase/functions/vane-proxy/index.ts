import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import mysql from "npm:mysql2/promise";
import { Buffer } from "node:buffer";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── In-memory cache ────────────────────────────────────────────────────────────
// Persists across warm requests within the same Edge Function instance.
// TTL: 5 minutes for product lists, 10 minutes for the classes list.
const CACHE_TTL_PRODUCTS_MS = 5 * 60 * 1000;   // 5 min
const CACHE_TTL_CLASSES_MS  = 10 * 60 * 1000;  // 10 min

interface CacheEntry { data: unknown; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key: string, data: unknown, ttlMs: number) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── MySQL connection with retry ────────────────────────────────────────────────
async function createConnection(ca_cert: string, client_cert: string, client_key: string, attempt = 1) {
  const host     = Deno.env.get('VANE_DB_HOST');
  const user     = Deno.env.get('VANE_DB_USER');
  const password = Deno.env.get('VANE_DB_PASS');
  const database = Deno.env.get('VANE_DB_NAME');

  if (!host || !user || !password || !database) {
    throw new Error('Credenciais do banco de dados não configuradas nos Secrets da Edge Function.');
  }

  try {
    const conn = await mysql.createConnection({
      host,
      user,
      password,
      database,
      charset: 'utf8mb4',
      connectTimeout: 8000,
      ssl: {
        ca: ca_cert,
        key: client_key,
        cert: client_cert,
        rejectUnauthorized: false
      }
    });
    await conn.execute("SET NAMES utf8mb4");
    return conn;
  } catch (err) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 1000));
      return createConnection(ca_cert, client_cert, client_key, attempt + 1);
    }
    throw err;
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const page         = parseInt(url.searchParams.get('page')  || '1');
    const limit        = parseInt(url.searchParams.get('limit') || '12');
    const offset       = (page - 1) * limit;
    const fetchIds     = url.searchParams.get('ids');
    const action       = url.searchParams.get('action');
    const classeFilter = url.searchParams.get('classe');

    // ── Build cache key ──────────────────────────────────────────────────────
    let cacheKey: string | null = null;
    let cacheTtl = CACHE_TTL_PRODUCTS_MS;

    if (action === 'classes') {
      cacheKey = 'classes';
      cacheTtl = CACHE_TTL_CLASSES_MS;
    } else if (fetchIds) {
      cacheKey = `ids:${fetchIds}`;
    } else if (classeFilter && classeFilter !== 'Todos') {
      cacheKey = `classe:${classeFilter}:p${page}:l${limit}`;
    } else {
      cacheKey = `all:p${page}:l${limit}`;
    }

    // ── Cache hit? Return immediately ────────────────────────────────────────
    if (cacheKey) {
      const cached = cacheGet(cacheKey);
      if (cached !== null) {
        return new Response(JSON.stringify(cached), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, s-maxage=300',
            'X-Cache': 'HIT'
          }
        });
      }
    }

    // ── SSL secrets ──────────────────────────────────────────────────────────
    const ca_cert     = Deno.env.get('VANE_CA_CERT')?.replace(/\\n/g, '\n');
    const client_cert = Deno.env.get('VANE_CLIENT_CERT')?.replace(/\\n/g, '\n');
    const client_key  = Deno.env.get('VANE_CLIENT_KEY')?.replace(/\\n/g, '\n');

    if (!ca_cert || !client_cert || !client_key) {
      throw new Error("Misconfigured MySQL SSL Secrets in Edge Function");
    }

    // ── Connect (with retry) ─────────────────────────────────────────────────
    const connection = await createConnection(ca_cert, client_cert, client_key);

    let results: unknown[] = [];

    if (action === 'classes') {
      const [rows] = await connection.execute(
        `SELECT DISTINCT Classe FROM produtos
         WHERE Setor = 'CATÁLOGO' AND Ativo = 1
           AND NomeDaImagem IS NOT NULL AND NomeDaImagem != ''
           AND Classe IS NOT NULL AND Classe != ''`
      ) as [Array<{Classe: string}>];
      results = rows.map((r) => r.Classe);
      await connection.end();

      cacheSet(cacheKey!, results, cacheTtl);

      return new Response(JSON.stringify(results), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60, s-maxage=300',
          'X-Cache': 'MISS'
        }
      });

    } else if (fetchIds) {
      const idsArray = fetchIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
      if (idsArray.length === 0) {
        await connection.end();
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const placeholders = idsArray.map(() => '?').join(',');
      const [rows] = await connection.execute(
        `SELECT CodigoDoProduto, Descricao, ValorLocacao, NomeDaImagem, Classe
         FROM produtos
         WHERE CodigoDoProduto IN (${placeholders}) AND Setor = 'CATÁLOGO'`,
        idsArray
      ) as [Array<Record<string, unknown>>];
      results = rows;

    } else if (classeFilter && classeFilter !== 'Todos') {
      const [rows] = await connection.execute(
        `SELECT CodigoDoProduto, Descricao, ValorLocacao, NomeDaImagem, Classe
         FROM produtos
         WHERE Ativo = 1 AND Setor = 'CATÁLOGO' AND Classe = ?
           AND NomeDaImagem IS NOT NULL AND NomeDaImagem != ''
         LIMIT ? OFFSET ?`,
        [classeFilter, String(limit), String(offset)]
      ) as [Array<Record<string, unknown>>];
      results = rows;

    } else {
      const [rows] = await connection.execute(
        `SELECT CodigoDoProduto, Descricao, ValorLocacao, NomeDaImagem, Classe
         FROM produtos
         WHERE Ativo = 1 AND Setor = 'CATÁLOGO'
           AND NomeDaImagem IS NOT NULL AND NomeDaImagem != ''
         LIMIT ? OFFSET ?`,
        [String(limit), String(offset)]
      ) as [Array<Record<string, unknown>>];
      results = rows;
    }

    await connection.end();

    // ── Map output ───────────────────────────────────────────────────────────
    const finalData = (results as Array<Record<string, unknown>>).map((row) => ({
      id:        row.CodigoDoProduto,
      nome:      row.Descricao,
      preco:     row.ValorLocacao,
      categoria: row.Classe,
      img_url:   row.NomeDaImagem
        ? `https://fotos2.vanesistemas.com/app/arquivo_publico2/395/23894710000108/${row.NomeDaImagem}`
        : null
    }));

    if (cacheKey) cacheSet(cacheKey, finalData, cacheTtl);

    return new Response(JSON.stringify(finalData), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        'X-Cache': 'MISS'
      }
    });

  } catch (error) {
    console.error('[vane-proxy] error:', error);
    return new Response(
      JSON.stringify({ error: "Serviço temporariamente indisponível." }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 503
      }
    );
  }
});
