// Extracted verbatim from terrain-and-sector-dashboards.html, its <script type="text/x-dc"> block.
// Reference only: it is not part of the build. Every number it draws is synthetic.

class Component extends DCLogic {
  componentDidMount() {
    this.timer = setInterval(() => {
      const st = this.state || {};
      if (!st.playing) return;
      const t = (st.t == null ? 308 : st.t) + 1;
      this.setState({ t: t > 322 ? 0 : t });
    }, 450);
  }
  componentWillUnmount() { clearInterval(this.timer); }
  renderVals() {
    const st = this.state || {};
    const lang = st.lang || 'es';
    const I18N = {
      es: {
        loc: 'es-AR',
        mon: ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'],
        full: ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'],
        ini: ['E','F','M','A','M','J','J','A','S','O','N','D'],
        sect: { bo: ['Chaco boliviano', 'Bolivia · noroeste'], py: ['Chaco Boreal', 'Paraguay · noreste'], ar: ['Chaco Seco', 'Argentina · suroeste'], hu: ['Chaco Húmedo', 'AR · PY · este'], all: ['Todo el Gran Chaco', 'AR · PY · BO'] },
        language: 'Idioma', drawHint: 'Marcá puntos en el mapa y hacé doble clic para cerrar la forma.',
        hotspots: 'Hotspots', celldays: 'Celda-días', exportCsv: 'Exportar CSV', sectors: 'Sectores',
        less: 'Menos', moreLegend: 'Más · altura = media de hotspots armonizados 2000–2026 · fuera del Chaco, atenuado como contexto',
        vsMedian: 'vs. mediana de', median: 'mediana', ytd: 'Acumulado', crit: 'Período crítico', critSub: '80 % de un año mediano',
        byMonth: 'por mes', barLegend: 'barra · mediana · mitad central de los años', seenBy: 'Medido por:',
        calHelp: 'Mes × año en unidades VIIRS S-NPP. Tocá una celda para mover la línea de tiempo.',
        calNote: 'Los años en gris antes de 2012 son MODIS traducido a unidades VIIRS; 2000–01 usan el modelo solo Terra.',
        anHelp: 'Cada mes contra la mediana de ese mismo mes en todos los demás años.',
        half: '½× o menos', double: '2× o más',
        trendHelp: 'Totales por año. Contorno gris: los archivos apilados tal como llegan. Naranja: armonizado.',
        area: 'Área', h3cells: 'celdas H3', files: 'Archivos', from: 'Desde', to: 'Hasta', preview: 'Vista previa',
        processed: 'Solo valores procesados: conteos armonizados, intervalos y cobertura. No incluye filas crudas de FIRMS.',
        nov2026: 'Nov 2026', ariaArea: 'Elegir área por', nLat: 'Latitud norte', sLat: 'Latitud sur', wLon: 'Longitud oeste', eLon: 'Longitud este',
        nS: 'N', sS: 'S', wS: 'O', eS: 'E', unit: 'Unidad', dash: 'Panel del sector', close: 'Cerrar exportación', month: 'Mes',
        trendAria: 'Totales anuales 2000–2026, armonizados frente al apilado crudo',
        mapAria: 'Terreno 3D del norte argentino, Paraguay, sur de Bolivia y suroeste de Brasil: columnas H3 extruidas según la actividad de fuego armonizada, con los cuatro sectores del Gran Chaco resaltados',
        brazil: 'BRASIL',
        normal: 'Dentro de lo normal', above: 'Arriba de lo normal', below: 'Debajo de lo normal', nodata: 'Sin datos aún', na: 's/d',
        vsMedTo: 'vs. mediana hasta', timesMedian: 'veces la mediana', noDataCell: 'sin datos aún',
        chartAria: (y) => 'Valores mensuales de ' + y + ' frente a la mediana y la mitad central de los demás años',
        src: { terra: 'Pasada matutina de Terra MODIS, traducida con el modelo solo Terra.', modis: 'Terra + Aqua MODIS, traducido a equivalente VIIRS con el modelo ganador.', bridge: 'S-NPP hasta el 2 de nov., luego NOAA-20 puenteado a unidades S-NPP. Mes en curso.', snpp: 'VIIRS S-NPP, observado (375 m).' },
        cov: { terra: 'Solo Terra · traducido', modis: 'MODIS · traducido', bridge: 'NOAA-20 puenteado', snpp: 'VIIRS S-NPP' },
        trend: (a, b) => 'Apilados tal como llegan, 2012–21 parece ' + a + ' % más activo que 2002–11. Armonizado, la diferencia es ' + b + ' %: la parte que es fuego y no cambio de satélite.',
        ds: [['monthly', 'Calendario mensual', 'Totales mes × año con intervalos del 90 % y el satélite detrás de cada valor.'], ['anomalies', 'Anomalías', 'Mediana del mismo mes, razón y marca de anomalía para cada mes.'], ['hotspots', 'Hotspots armonizados', 'Una fila por celda H3 y semana, ponderada a equivalente VIIRS.']],
        pick1: 'Elegí al menos un archivo', dl: (n) => 'Descargar ' + n + (n === 1 ? ' CSV' : ' CSV (zip)'),
        tabs: ['Resumen', 'Calendario', 'Anomalías', 'Tendencia'], modes: ['Sectores', 'Dibujar', 'Lat / lon'],
        showPanels: 'Mostrar paneles', focus: 'Enfocar mapa', pauseT: 'Pausar línea de tiempo', playT: 'Reproducir línea de tiempo'
      },
      en: {
        loc: 'en-US',
        mon: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
        full: ['January','February','March','April','May','June','July','August','September','October','November','December'],
        ini: ['J','F','M','A','M','J','J','A','S','O','N','D'],
        sect: { bo: ['Bolivian Chaco', 'Bolivia · north-west'], py: ['Chaco Boreal', 'Paraguay · north-east'], ar: ['Dry Chaco', 'Argentina · south-west'], hu: ['Humid Chaco', 'AR · PY · east'], all: ['Whole Gran Chaco', 'AR · PY · BO'] },
        language: 'Language', drawHint: '{{L.drawHint}}',
        hotspots: 'Hotspots', celldays: 'Cell-days', exportCsv: 'Export CSV', sectors: 'Sectors',
        less: 'Less', moreLegend: 'More · height = mean harmonized hotspots 2000–2026 · outside the Chaco shown dimmed for context',
        vsMedian: 'vs median', median: 'median', ytd: 'Season to date', crit: 'Critical period', critSub: '80 % of a median year',
        byMonth: 'by month', barLegend: 'bar · median · middle half of years', seenBy: 'Seen by:',
        calHelp: 'Month × year in VIIRS S-NPP units. Pick a cell to move the timeline.',
        calNote: 'Years in grey before 2012 are MODIS translated to VIIRS units; 2000–01 use the Terra-only model.',
        anHelp: 'Each month against the median of that month in every other year.',
        half: '½× or less', double: '2× or more',
        trendHelp: 'Yearly totals. Grey outline: the files stacked as delivered. Orange: harmonized.',
        area: 'Area', h3cells: 'H3 cells', files: 'Files', from: 'From', to: 'To', preview: 'Preview',
        processed: 'Processed values only: harmonized counts, intervals and coverage. Raw FIRMS rows are not included.',
        nov2026: 'Nov 2026', ariaArea: 'Choose area by', nLat: 'North latitude', sLat: 'South latitude', wLon: 'West longitude', eLon: 'East longitude',
        nS: 'N', sS: 'S', wS: 'W', eS: 'E', unit: 'Unit', dash: 'Sector dashboard', close: 'Close export', month: 'Month',
        trendAria: 'Yearly totals 2000 to 2026, harmonized compared with raw stacking',
        mapAria: '3D terrain of northern Argentina, Paraguay, southern Bolivia and south-west Brazil: H3 columns extruded by harmonized fire activity, with the four Gran Chaco sectors highlighted',
        brazil: 'BRAZIL',
        normal: 'Within normal range', above: 'Above normal', below: 'Below normal', nodata: 'No data yet', na: 'n/a',
        vsMedTo: 'vs median to', timesMedian: 'times the median', noDataCell: 'no data yet',
        chartAria: (y) => 'Monthly values in ' + y + ' against the median and the middle half of other years',
        src: { terra: 'Terra MODIS morning pass, translated with the Terra-only model.', modis: 'Terra + Aqua MODIS, translated to VIIRS-equivalent by the winning model.', bridge: 'S-NPP until 2 Nov, then NOAA-20 bridged to S-NPP units. Month in progress.', snpp: 'VIIRS S-NPP, observed (375 m).' },
        cov: { terra: 'Terra only · translated', modis: 'MODIS · translated', bridge: 'NOAA-20 bridged', snpp: 'VIIRS S-NPP' },
        trend: (a, b) => 'Stacked as delivered, 2012–21 looks ' + a + ' % busier than 2002–11. Harmonized, the difference is ' + b + ' %: the part that is fire, not the change of satellite.',
        ds: [['monthly', 'Monthly calendar', 'Month × year totals with 90 % intervals and the satellite behind each value.'], ['anomalies', 'Anomalies', 'Same-month median, ratio and anomaly flag for every month.'], ['hotspots', 'Harmonized hotspots', 'One row per H3 cell and week, weighted to VIIRS-equivalent.']],
        pick1: 'Pick at least one file', dl: (n) => 'Download ' + n + (n === 1 ? ' CSV' : ' CSVs (zip)'),
        tabs: ['Overview', 'Calendar', 'Anomalies', 'Trend'], modes: ['Sectors', 'Draw', 'Lat / lon'],
        showPanels: 'Show panels', focus: 'Focus map', pauseT: 'Pause timeline', playT: 'Play timeline'
      }
    };
    const L = I18N[lang];
    const MON = L.mon, FULL = L.full;
    const RAMP = ['#1A1030','#320A5E','#781C6D','#BC3754','#ED6925','#FBB61A','#FCFFA4'];
    const DIV = ['#7DB3FF','#4A7FC9','#2C4A70','#232B35','#7A4A22','#C46A1E','#F5A35C'];
    const SECT = [
      { id: 'bo', cells: 97, k: 0.7, peak: 8, x: '34.5%', y: '30.2%' },
      { id: 'py', cells: 128, k: 1.0, peak: 8, x: '45.3%', y: '29.7%' },
      { id: 'ar', cells: 269, k: 0.85, peak: 7, x: '46.6%', y: '51.1%' },
      { id: 'hu', cells: 114, k: 0.55, peak: 8, x: '57.2%', y: '46.6%' }
    ].map((s) => Object.assign(s, { name: L.sect[s.id][0], sub: L.sect[s.id][1] }));
    const ALL = { id: 'all', name: L.sect.all[0], sub: L.sect.all[1], cells: 608 };
    const unit = st.unit || 'hot';
    const t = st.t == null ? 308 : st.t;
    const Y = 2000 + Math.floor(t / 12), M = t % 12;
    const selId = st.sector || 'py';
    const tab = st.tab || 'overview';
    const NOW = { y: 2026, m: 10 };
    const years = []; for (let y = 2000; y <= 2026; y++) years.push(y);

    const gen = (s, si) => {
      let seed = 17 + si * 101;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const season = MON.map((_, m) => { const d = Math.min(Math.abs(m - s.peak), 12 - Math.abs(m - s.peak)); return 0.07 + Math.exp(-d * d / 3.2); });
      const out = {};
      years.forEach((y) => {
        const yf = 0.55 + rnd() * 0.9 + ((y === 2019 || y === 2020) && s.id !== 'hu' ? 0.8 : 0);
        out[y] = season.map((v, m) => {
          if (y === 2026 && m === 11) return null;
          const x = Math.round(520 * s.k * v * yf * (0.75 + rnd() * 0.5));
          return y === NOW.y && m === NOW.m ? Math.round(x * 0.45) : x;
        });
      });
      return out;
    };
    const D = {};
    SECT.forEach((s, i) => { D[s.id] = gen(s, i); });
    D.all = {};
    years.forEach((y) => { D.all[y] = MON.map((_, m) => D.bo[y][m] == null ? null : SECT.reduce((a, s) => a + D[s.id][y][m], 0)); });
    const cellsOf = (id) => id === 'all' ? ALL.cells : SECT.find((s) => s.id === id).cells;
    const conv = (v, cells) => v == null ? null : unit === 'hot' ? v : Math.round(Math.min(v, cells * 30) * 0.55);
    const series = (id) => { const c = cellsOf(id), o = {}; years.forEach((y) => { o[y] = D[id][y].map((v) => conv(v, c)); }); return o; };
    const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
    const others = (S, y, m) => years.filter((o) => o !== y && S[o][m] != null && !(o === NOW.y && m === NOW.m)).map((o) => S[o][m]);
    const medianFor = (S, y, m) => { const b = pct(others(S, y, m), 0.5); return y === NOW.y && m === NOW.m ? b * 0.45 : b; };
    const binOf = (r) => { const l = Math.log2(r); if (l <= -1) return 0; if (l <= -0.5) return 1; if (l <= -0.15) return 2; if (l < 0.15) return 3; if (l < 0.5) return 4; if (l < 1) return 5; return 6; };
    const fmt = (n) => n == null ? '—' : Math.round(n).toLocaleString(L.loc);
    const dec = (n, d) => Number(n).toLocaleString(L.loc, { minimumFractionDigits: d, maximumFractionDigits: d });
    const unc = (y, m) => y < 2002 ? 0.22 : y < 2012 ? 0.14 : (y === NOW.y && m >= 10) ? 0.09 : 0.04;
    const chipFor = (r) => { const b = binOf(r); return b < 3 ? { bg: '#16263D', fg: '#7DB3FF' } : b > 3 ? { bg: '#4A2A10', fg: '#F5A35C' } : { bg: '#232B35', fg: '#C9D3DD' }; };
    const era = (y, m) => y < 2002 ? 'terra' : y < 2012 ? 'modis' : (y === NOW.y && m >= 10) ? 'bridge' : 'snpp';
    const coverShort = L.cov[era(Y, M)];

    const SS = {}; SECT.concat([ALL]).forEach((s) => { SS[s.id] = series(s.id); });
    const ratioAt = (id, y, m) => { const v = SS[id][y][m]; return v == null ? null : v / medianFor(SS[id], y, m); };

    const sec = {};
    SECT.forEach((s) => {
      const on = selId === s.id || selId === 'all';
      sec[s.id] = { op: on ? 1 : 0.62, stroke: selId === s.id ? '#FCFFA4' : 'rgba(232,237,242,0.25)' };
    });
    const pick = (id) => () => this.setState({ sector: id, exportOpen: false });
    const pins = SECT.map((s) => { const r = ratioAt(s.id, Y, M); const c = r == null ? { fg: '#9AA6B2' } : chipFor(r); return { name: s.name, x: s.x, y: s.y, on: selId === s.id ? 'true' : 'false', border: selId === s.id ? '#FCFFA4' : '#2A3440', val: fmt(SS[s.id][Y][M]) + (r == null ? '' : ' · ×' + dec(r, 1)), valColor: c.fg, pick: pick(s.id) }; });
    const sectorList = [ALL].concat(SECT).map((s) => { const r = ratioAt(s.id, Y, M); const c = r == null ? { bg: '#232B35', fg: '#9AA6B2' } : chipFor(r); return { name: s.name, sub: s.sub, val: fmt(SS[s.id][Y][M]), ratio: r == null ? L.na : '×' + dec(r, 2), chipBg: c.bg, chipFg: c.fg, on: selId === s.id ? 'true' : 'false', border: selId === s.id ? '#FCFFA4' : '#1E2935', bg: selId === s.id ? '#17202B' : 'transparent', pick: pick(s.id) }; });

    const cur = selId === 'all' ? ALL : SECT.find((s) => s.id === selId);
    const S = SS[selId];
    const v = S[Y][M];
    const med = medianFor(S, Y, M);
    const r = v == null ? null : v / med;
    const u = unc(Y, M);
    let chip = L.normal, cB = '#232B35', cF = '#E8EDF2';
    if (v != null && v * (1 - u) > med * 1.15) { chip = L.above; cB = '#4A2A10'; cF = '#F5A35C'; }
    if (v != null && v * (1 + u) < med * 0.87) { chip = L.below; cB = '#16263D'; cF = '#7DB3FF'; }
    if (v == null) chip = L.nodata;
    let ytd = 0, ytdMed = 0;
    for (let m = 0; m <= M; m++) { ytd += S[Y][m] || 0; ytdMed += medianFor(S, Y, m); }
    const medAll = MON.map((_, m) => pct(others(S, -1, m), 0.5));
    const tot = medAll.reduce((a, b) => a + b, 0);
    let best = null;
    for (let len = 1; len <= 12 && !best; len++) for (let s0 = 0; s0 < 12; s0++) { let sum = 0; for (let q = 0; q < len; q++) sum += medAll[(s0 + q) % 12]; if (sum >= 0.8 * tot && (!best || sum > best.sum)) best = { s0, len, sum }; }
    const k = {
      value: fmt(v), lo: fmt(v == null ? null : v * (1 - u)), hi: fmt(v == null ? null : v * (1 + u)),
      ratio: r == null ? '—' : '×' + dec(r, 2), ratioColor: r == null ? '#9AA6B2' : chipFor(r).fg,
      median: fmt(med), monthName: MON[M], year: Y,
      ytd: fmt(ytd), ytdVs: (ytd >= ytdMed ? '+' : '−') + Math.abs(Math.round((ytd / ytdMed - 1) * 100)) + ' % ' + L.vsMedTo + ' ' + MON[M],
      crit: best ? MON[best.s0] + '–' + MON[(best.s0 + best.len - 1) % 12] : '—',
      chip, chipBg: cB, chipFg: cF,
      source: L.src[era(Y, M)],
      chartAria: L.chartAria(Y)
    };
    const stats = MON.map((_, m) => { const xs = others(S, Y, m); return { p25: pct(xs, 0.25), p50: pct(xs, 0.5), p75: pct(xs, 0.75), v: S[Y][m] }; });
    const top = Math.max.apply(null, stats.map((s) => Math.max(s.p75, s.v || 0))) * 1.08;
    const h = (x) => (x / top * 100).toFixed(1) + '%';
    const bars = stats.map((s, m) => ({ bandBottom: h(s.p25), bandH: h(s.p75 - s.p25), medB: h(s.p50), valH: s.v == null ? '0%' : h(s.v), fill: m === M ? '#FBB61A' : '#ED6925' }));

    let mx = 0; years.forEach((y) => S[y].forEach((x) => { if (x != null && x > mx) mx = x; }));
    const seqColor = (x) => x == null ? '#1A222C' : RAMP[Math.min(6, Math.floor(Math.log1p(x) / Math.log1p(mx) * 7))];
    const goto = (y, m) => () => this.setState({ t: (y - 2000) * 12 + m, playing: false });
    const ring = (y, m) => (y === Y && m === M) ? '0 0 0 2px #E8EDF2' : 'none';
    const calRows = years.slice().reverse().map((y) => ({ y: y, yColor: y < 2012 ? '#7D8996' : '#C9D3DD', cells: S[y].map((x, m) => ({ bg: seqColor(x), ring: ring(y, m), aria: FULL[m] + ' ' + y + ': ' + (x == null ? L.noDataCell : fmt(x)), pick: goto(y, m) })) }));
    const anRows = years.slice().reverse().map((y) => ({ y: y, cells: S[y].map((x, m) => { const rr = x == null ? null : x / medianFor(S, y, m); return { bg: rr == null ? '#1A222C' : DIV[binOf(rr)], ring: ring(y, m), aria: FULL[m] + ' ' + y + ': ' + (rr == null ? L.noDataCell : dec(rr, 2) + ' ' + L.timesMedian), pick: goto(y, m) }; }) }));
    const totals = years.map((y) => S[y].reduce((a, x) => a + (x || 0), 0));
    const raws = years.map((y, i) => y < 2012 ? totals[i] * 0.58 : totals[i]);
    const tmax = Math.max.apply(null, totals.concat(raws)) * 1.05;
    const trend = years.map((y, i) => ({ h: (totals[i] / tmax * 100).toFixed(1) + '%', raw: (raws[i] / tmax * 100).toFixed(1) + '%', fill: y === Y ? '#FBB61A' : '#ED6925' }));
    const avg = (a) => a.reduce((x, z) => x + z, 0) / a.length;
    const pre = totals.slice(2, 12), post = totals.slice(12, 22);
    const rawJump = Math.round((avg(post) / (avg(pre) * 0.58) - 1) * 100);
    const harmJump = Math.round((avg(post) / avg(pre) - 1) * 100);
    const trendNote = L.trend(rawJump, (harmJump >= 0 ? '+' : '−') + Math.abs(harmJump));

    const ds = st.ds || { monthly: true, hotspots: true, anomalies: true };
    const datasets = L.ds.map((d) => ({ label: d[1], desc: d[2], on: !!ds[d[0]], toggle: () => { const n = Object.assign({}, ds); n[d[0]] = !ds[d[0]]; this.setState({ ds: n }); } }));
    const nSel = L.ds.filter((d) => ds[d[0]]).length;
    const preview = [0, 1, 2, 3].map((i) => { const tt = Math.max(0, t - 3) + i; const yy = 2000 + Math.floor(tt / 12), mm = tt % 12; const x = S[yy][mm]; const md = medianFor(S, yy, mm); const uu = unc(yy, mm); const e = era(yy, mm); return { month: yy + '-' + String(mm + 1).padStart(2, '0'), v: x == null ? '' : x, lo: x == null ? '' : Math.round(x * (1 - uu)), hi: x == null ? '' : Math.round(x * (1 + uu)), med: Math.round(md), ratio: x == null ? '' : (x / md).toFixed(2), src: { terra: 'terra_model', modis: 'modis_model', bridge: 'noaa20_bridged', snpp: 'snpp' }[e] }; });

    const tabKeys = ['overview', 'calendar', 'anom', 'trend'];
    const areaMode = st.areaMode || 'sector';
    const exportOpen = !!st.exportOpen;
    return {
      lang, L,
      langs: [['es', 'ES'], ['en', 'EN']].map((p) => ({ label: p[1], on: lang === p[0] ? 'true' : 'false', bg: lang === p[0] ? '#2A3440' : 'transparent', fg: lang === p[0] ? '#E8EDF2' : '#9AA6B2', pick: () => this.setState({ lang: p[0] }) })),
      sec, pins, sectorList, cur, k, bars, calRows, anRows, trend, trendNote,
      ramp: RAMP, divRamp: DIV,
      monInitials: L.ini,
      monthLabel: MON[M] + ' ' + Y,
      coverShort, t,
      tabs: tabKeys.map((key, i) => ({ label: L.tabs[i], on: tab === key ? 'true' : 'false', bg: tab === key ? '#2A3440' : 'transparent', fg: tab === key ? '#E8EDF2' : '#9AA6B2', pick: () => this.setState({ tab: key }) })),
      tabOverview: tab === 'overview', tabCalendar: tab === 'calendar', tabAnom: tab === 'anom', tabTrend: tab === 'trend',
      dashOpen: !exportOpen, exportOpen,
      openExport: () => this.setState({ exportOpen: true }),
      closeExport: () => this.setState({ exportOpen: false }),
      datasets, preview,
      downloadLabel: nSel === 0 ? L.pick1 : L.dl(nSel),
      unitKey: unit === 'hot' ? 'hotspots' : 'cell_days',
      areaModes: ['sector', 'draw', 'box'].map((key, i) => ({ label: L.modes[i], on: areaMode === key ? 'true' : 'false', bg: areaMode === key ? '#2A3440' : 'transparent', fg: areaMode === key ? '#E8EDF2' : '#9AA6B2', pick: () => this.setState({ areaMode: key }) })),
      showBox: areaMode === 'box', showDraw: areaMode === 'draw',
      isHot: unit === 'hot' ? 'true' : 'false', isDays: unit !== 'hot' ? 'true' : 'false',
      hotBg: unit === 'hot' ? '#2A3440' : 'transparent', hotFg: unit === 'hot' ? '#E8EDF2' : '#9AA6B2',
      daysBg: unit !== 'hot' ? '#2A3440' : 'transparent', daysFg: unit !== 'hot' ? '#E8EDF2' : '#9AA6B2',
      toHot: () => this.setState({ unit: 'hot' }), toDays: () => this.setState({ unit: 'days' }),
      ctxOp: 0.42,
      showPanels: !st.focus, focusOn: st.focus ? 'true' : 'false', focusLabel: st.focus ? L.showPanels : L.focus,
      toggleFocus: () => this.setState({ focus: !st.focus }),
      playing: !!st.playing, paused: !st.playing,
      playLabel: st.playing ? L.pauseT : L.playT,
      togglePlay: () => this.setState({ playing: !st.playing }),
      scrub: (e) => this.setState({ t: Number(e.target.value), playing: false })
    };
  }
}
