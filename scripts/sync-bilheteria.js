// Sincroniza vendas (tickets) da API da Bilheteria Digital com o Supabase (tabela lab_state, linha id=3).
// Roda via GitHub Actions em cron. Node 20+ (fetch nativo, sem dependências externas).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BD_SEED_TOKEN = process.env.BD_SEED_TOKEN; // usado só se ainda não houver token salvo no Supabase
const BD_BASE = "https://ms.bilheteriadigital.net/partners";
const CONFIG_ROW_ID = 3; // linha dedicada à sincronização, separada do estado principal do app (id=1)

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY nos secrets do repo.");
  process.exit(1);
}

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function getConfig() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/lab_state?id=eq.${CONFIG_ROW_ID}&select=data`,
    { headers: sbHeaders }
  );
  const rows = await res.json();
  if (Array.isArray(rows) && rows.length > 0) return rows[0].data;
  return { token: BD_SEED_TOKEN || null, eventos: [], resultados: {} };
}

async function saveConfig(data) {
  const patch = await fetch(
    `${SUPABASE_URL}/rest/v1/lab_state?id=eq.${CONFIG_ROW_ID}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ data }),
    }
  );
  const patched = await patch.json();
  if (Array.isArray(patched) && patched.length > 0) return;

  await fetch(`${SUPABASE_URL}/rest/v1/lab_state`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ id: CONFIG_ROW_ID, data }),
  });
}

async function refreshToken(oldToken) {
  try {
    const res = await fetch(`${BD_BASE}/generate-token`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: oldToken },
      body: JSON.stringify({ old_token: oldToken }),
    });
    const body = await res.json();
    const newToken =
      body?.body?.Token || body?.Token || body?.token || body?.body?.token;
    if (newToken) {
      console.log("Token renovado com sucesso.");
      return newToken;
    }
    console.warn("generate-token não retornou um token reconhecível:", JSON.stringify(body));
    return oldToken;
  } catch (e) {
    console.warn("Falha ao renovar token, usando o atual:", e.message);
    return oldToken;
  }
}

async function fetchAllTickets(idEvent, token) {
  let page = 1;
  let totalPages = 1;
  const tickets = [];
  do {
    const url = `${BD_BASE}/tickets?id_event=${idEvent}&page=${page}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: token } });
    const rawText = await res.text();
    console.log(`  [debug] página ${page}: HTTP ${res.status}, resposta: ${rawText.slice(0, 500)}`);
    if (!res.ok) {
      console.warn(`Evento ${idEvent}: erro HTTP ${res.status} na página ${page}`);
      break;
    }
    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      console.warn(`Evento ${idEvent}: resposta não é JSON válido`);
      break;
    }
    const body = json?.body;
    if (!body) break;
    tickets.push(...(body.tickets || []));
    totalPages = body.total_pages || 1;
    page++;
  } while (page <= totalPages);
  return tickets;
}

function aggregate(tickets) {
  const out = {
    total: tickets.length,
    valorTotal: 0,
    porSetor: {},
    porTipo: {},
    porDia: {},
  };
  for (const t of tickets) {
    const valor = parseFloat(String(t.value || "0").replace(",", ".")) || 0;
    out.valorTotal += valor;

    const setor = t.sector_name || "—";
    out.porSetor[setor] = out.porSetor[setor] || { qtd: 0, valor: 0 };
    out.porSetor[setor].qtd++;
    out.porSetor[setor].valor += valor;

    const tipo = t.ticket_type_name || "—";
    out.porTipo[tipo] = out.porTipo[tipo] || { qtd: 0, valor: 0 };
    out.porTipo[tipo].qtd++;
    out.porTipo[tipo].valor += valor;

    const dia = (t.order_datetime || "").slice(0, 10);
    if (dia) {
      out.porDia[dia] = out.porDia[dia] || { qtd: 0, valor: 0 };
      out.porDia[dia].qtd++;
      out.porDia[dia].valor += valor;
    }
  }
  out.valorTotal = Math.round(out.valorTotal * 100) / 100;
  return out;
}

async function main() {
  const config = await getConfig();

  if (!config.token) {
    console.error("Nenhum token disponível (nem salvo no Supabase, nem BD_SEED_TOKEN). Abortando.");
    process.exit(1);
  }

  const newToken = await refreshToken(config.token);
  config.token = newToken;

  if (!Array.isArray(config.eventos) || config.eventos.length === 0) {
    console.log("Nenhum evento configurado em lab_state.id=3.data.eventos ainda. Nada a sincronizar.");
    await saveConfig(config);
    return;
  }

  config.resultados = config.resultados || {};
  for (const evento of config.eventos) {
    const idEvent = evento.id_event;
    console.log(`Buscando tickets do evento ${idEvent} (${evento.nome || "sem nome"})...`);
    const tickets = await fetchAllTickets(idEvent, newToken);
    const agg = aggregate(tickets);
    agg.atualizadoEm = new Date().toISOString();
    config.resultados[idEvent] = agg;
    console.log(`  -> ${agg.total} tickets, R$ ${agg.valorTotal}`);
  }

  await saveConfig(config);
  console.log("Sincronização concluída.");
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
