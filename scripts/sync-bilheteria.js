  if (process.env.DEBUG_LIST_EVENTS === "true") {
    console.log("Modo diagnóstico: buscando tickets SEM filtro de evento...");
    const url = `${BD_BASE}/tickets?page=1&limit=50`;
    const res = await fetch(url, { headers: { Authorization: newToken } });
    const rawText = await res.text();
    console.log(`HTTP ${res.status}: ${rawText.slice(0, 2000)}`);
    await saveConfig(config);
    return;
  }
