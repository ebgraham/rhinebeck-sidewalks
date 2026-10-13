// Rhinebeck Village sidewalk survey map.
// Reads parcels from Supabase (PostgREST) and saves assessments back to
// Supabase when the sidewalk_assessments table exists (see sql/assessments.sql).
// If Supabase saving is not set up, assessments fall back to localStorage.

(function () {
  "use strict";

  var cfg = window.SURVEY_CONFIG || {};
  var BASE = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  var KEY = cfg.SUPABASE_ANON_KEY || "";
  var KEY_MISSING = !KEY || KEY === "PASTE_YOUR_PUBLISHABLE_KEY_HERE";

  var CONDITION_COLORS = {
    good: "#2ca25f",
    fair: "#fdae61",
    poor: "#d73027",
    missing: "#636363"
  };
  var CONDITION_LABELS = {
    good: "Good",
    fair: "Fair",
    poor: "Poor",
    missing: "Missing sidewalk"
  };

  var map = L.map("map").setView([41.926, -73.911], 15);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20
  }).addTo(map);

  var parcels = []; // GeoJSON features
  var assessments = {}; // parcelgrid -> {condition, notes, assessed_at, source}
  var supabaseSaving = false;
  var activeFilter = "all";
  var layer = null;
  var selectedGrid = null;

  var statsEl = document.getElementById("stats");
  var panelEl = document.getElementById("parcelPanel");
  var bannerEl = document.getElementById("banner");
  var loadingEl = document.getElementById("loading");

  function showBanner(html) {
    bannerEl.style.display = "block";
    bannerEl.innerHTML = html;
  }

  function apiHeaders() {
    return { apikey: KEY, "Content-Type": "application/json" };
  }

  // Fetch all rows from a PostgREST table, following offset pagination.
  function fetchAll(path) {
    var out = [];
    var offset = 0;
    function page() {
      var sep = path.indexOf("?") === -1 ? "?" : "&";
      return fetch(BASE + path + sep + "limit=1000&offset=" + offset, { headers: apiHeaders() })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (rows) {
          out = out.concat(rows);
          if (rows.length === 1000) {
            offset += 1000;
            return page();
          }
          return out;
        });
    }
    return page();
  }

  function loadLocalAssessments() {
    try {
      return JSON.parse(localStorage.getItem("rhinebeck-assessments") || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveLocalAssessments() {
    var local = {};
    Object.keys(assessments).forEach(function (grid) {
      if (assessments[grid].source === "local") local[grid] = assessments[grid];
    });
    localStorage.setItem("rhinebeck-assessments", JSON.stringify(local));
  }

  function styleFor(feature) {
    var a = assessments[feature.properties.parcelgrid];
    var isSelected = feature.properties.parcelgrid === selectedGrid;
    if (a && CONDITION_COLORS[a.condition]) {
      return {
        color: isSelected ? "#000" : "#fff",
        weight: isSelected ? 3 : 1,
        fillColor: CONDITION_COLORS[a.condition],
        fillOpacity: 0.65
      };
    }
    return {
      color: isSelected ? "#000" : "#3388ff",
      weight: isSelected ? 3 : 1,
      fillColor: "#3388ff",
      fillOpacity: isSelected ? 0.35 : 0.08
    };
  }

  function renderStats() {
    var counts = { good: 0, fair: 0, poor: 0, missing: 0 };
    var assessed = 0;
    Object.keys(assessments).forEach(function (grid) {
      var c = assessments[grid].condition;
      if (counts.hasOwnProperty(c)) {
        counts[c] += 1;
        assessed += 1;
      }
    });
    var parts = ["<b>" + parcels.length + "</b> parcels", "<b>" + assessed + "</b> assessed"];
    Object.keys(counts).forEach(function (c) {
      parts.push(
        '<span><span class="dot" style="background:' + CONDITION_COLORS[c] + '"></span>' +
        CONDITION_LABELS[c] + ": <b>" + counts[c] + "</b></span>"
      );
    });
    statsEl.innerHTML = parts.join(" ");
  }

  function visibleFeatures() {
    return parcels.filter(function (f) {
      var has = !!assessments[f.properties.parcelgrid];
      if (activeFilter === "assessed") return has;
      if (activeFilter === "unassessed") return !has;
      return true;
    });
  }

  function renderLayer() {
    if (layer) map.removeLayer(layer);
    layer = L.geoJSON(visibleFeatures(), {
      style: styleFor,
      onEachFeature: function (feature, l) {
        l.on("click", function () { selectParcel(feature.properties.parcelgrid); });
      }
    }).addTo(map);
    renderStats();
  }

  function selectParcel(grid) {
    selectedGrid = grid;
    renderLayer();
    var feature = null;
    for (var i = 0; i < parcels.length; i++) {
      if (parcels[i].properties.parcelgrid === grid) { feature = parcels[i]; break; }
    }
    if (!feature) return;
    var props = feature.properties;
    var a = assessments[grid] || {};
    var areaSqft = props.shape_area ? Math.round(props.shape_area).toLocaleString() : "—";
    var areaAcres = props.shape_area ? (props.shape_area / 43560).toFixed(2) : "—";
    panelEl.innerHTML =
      "<h2>Parcel " + escapeHtml(props.printkey || grid) + "</h2>" +
      '<div class="meta">Address: ' + escapeHtml((props.address_count > 1 && props.addresses) ? props.addresses + " (" + props.address_count + " addresses)" : (props.address || "No address on file")) +
      "<br>Grid ID: " + escapeHtml(grid) +
      "<br>Lot size: " + areaSqft + " sq ft (" + areaAcres + " acres)</div>" +
      '<label for="condSelect">Sidewalk condition</label>' +
      '<select id="condSelect">' +
      '<option value="">Not assessed</option>' +
      '<option value="good"' + (a.condition === "good" ? " selected" : "") + ">Good</option>" +
      '<option value="fair"' + (a.condition === "fair" ? " selected" : "") + ">Fair</option>" +
      '<option value="poor"' + (a.condition === "poor" ? " selected" : "") + ">Poor</option>" +
      '<option value="missing"' + (a.condition === "missing" ? " selected" : "") + ">Missing sidewalk</option>" +
      "</select>" +
      '<label for="notesInput">Notes</label>' +
      '<textarea id="notesInput" placeholder="Cracks, heaving, blocked, no curb ramp…"></textarea>' +
      '<button class="btn" id="saveBtn" type="button">Save assessment</button> ' +
      '<button class="btn secondary" id="clearBtn" type="button">Clear</button>' +
      '<div id="saveStatus"></div>';
    document.getElementById("notesInput").value = a.notes || "";
    document.getElementById("saveBtn").addEventListener("click", function () {
      var condition = document.getElementById("condSelect").value;
      var notes = document.getElementById("notesInput").value.trim();
      saveAssessment(grid, condition, notes);
    });
    document.getElementById("clearBtn").addEventListener("click", function () {
      saveAssessment(grid, "", "");
    });
    // Zoom to the parcel without changing zoom too aggressively.
    var bounds = L.geoJSON(feature).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.6));
  }

  function setStatus(text, cls) {
    var el = document.getElementById("saveStatus");
    if (el) {
      el.textContent = text;
      el.className = cls || "";
    }
  }

  function saveAssessment(grid, condition, notes) {
    if (!condition) {
      // Clearing: delete from Supabase if saving is on, else drop local copy.
      if (supabaseSaving) {
        fetch(BASE + "/rest/v1/sidewalk_assessments?parcelgrid=eq." + encodeURIComponent(grid), {
          method: "DELETE",
          headers: apiHeaders()
        }).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          delete assessments[grid];
          saveLocalAssessments();
          renderLayer();
          setStatus("Assessment cleared.", "ok");
        }).catch(function () {
          setStatus("Could not clear in Supabase. The record may still exist.", "err");
        });
      } else {
        delete assessments[grid];
        saveLocalAssessments();
        renderLayer();
        setStatus("Assessment cleared (was stored locally).", "ok");
      }
      return;
    }
    var record = {
      parcelgrid: grid,
      condition: condition,
      notes: notes || null,
      assessed_at: new Date().toISOString()
    };
    if (supabaseSaving) {
      fetch(BASE + "/rest/v1/sidewalk_assessments", {
        method: "POST",
        headers: Object.assign(apiHeaders(), { Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify(record)
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        assessments[grid] = Object.assign({}, record, { source: "supabase" });
        renderLayer();
        setStatus("Saved to Supabase.", "ok");
      }).catch(function () {
        assessments[grid] = Object.assign({}, record, { source: "local" });
        saveLocalAssessments();
        renderLayer();
        setStatus("Saved locally only — Supabase write failed.", "warn");
      });
    } else {
      assessments[grid] = Object.assign({}, record, { source: "local" });
      saveLocalAssessments();
      renderLayer();
      setStatus("Saved locally. Run the assessments SQL to enable Supabase saving (see README).", "warn");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function normalizeId(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  document.getElementById("searchBtn").addEventListener("click", function () {
    var q = normalizeId(document.getElementById("searchInput").value);
    if (!q) return;
    for (var i = 0; i < parcels.length; i++) {
      var p = parcels[i].properties;
      if (normalizeId(p.printkey).indexOf(q) !== -1 || normalizeId(p.parcelgrid).indexOf(q) !== -1 || normalizeId(p.address).indexOf(q) !== -1 || normalizeId(p.addresses).indexOf(q) !== -1) {
        selectParcel(p.parcelgrid);
        return;
      }
    }
    alert("No parcel matches that ID.");
  });

  document.querySelectorAll("#filters button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#filters button").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      activeFilter = btn.getAttribute("data-filter");
      renderLayer();
    });
  });

  document.getElementById("exportBtn").addEventListener("click", function () {
    var lines = ["parcelgrid,printkey,address,addresses,condition,notes,assessed_at,source"];
    var byGrid = {};
    parcels.forEach(function (f) { byGrid[f.properties.parcelgrid] = f.properties; });
    Object.keys(assessments).forEach(function (grid) {
      var a = assessments[grid];
      var csv = [grid, byGrid[grid] ? byGrid[grid].printkey || "" : "", byGrid[grid] ? byGrid[grid].address || "" : "", byGrid[grid] ? byGrid[grid].addresses || "" : "", a.condition || "", (a.notes || "").replace(/"/g, '""'), a.assessed_at || "", a.source || ""];
      lines.push(csv.map(function (v) { return '"' + v + '"'; }).join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rhinebeck-sidewalk-assessments.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Boot: fetch parcels, then assessments (Supabase first, local as fallback).
  if (KEY_MISSING) {
    showBanner(
      "Setup needed: paste your Supabase <b>publishable</b> key into <code>config.js</code> " +
      "(Supabase Dashboard &rarr; Project Settings &rarr; API). The map cannot load parcels until then."
    );
    loadingEl.textContent = "Waiting for the Supabase key in config.js.";
    return;
  }
  fetchAll("/rest/v1/parcels?select=parcelgrid,printkey,shape_area,address,addresses,address_count,geom&order=parcelgrid")
    .then(function (rows) {
      parcels = rows.map(function (r) {
        return {
          type: "Feature",
          properties: { parcelgrid: r.parcelgrid, printkey: r.printkey, shape_area: r.shape_area, address: r.address, addresses: r.addresses, address_count: r.address_count },
          geometry: r.geom
        };
      });
      loadingEl.textContent = "Loaded " + parcels.length + " parcels. Loading assessments…";
      return fetchAll("/rest/v1/sidewalk_assessments?select=parcelgrid,condition,notes,assessed_at&order=parcelgrid")
        .then(function (arows) {
          supabaseSaving = true;
          arows.forEach(function (r) {
            assessments[r.parcelgrid] = {
              condition: r.condition,
              notes: r.notes,
              assessed_at: r.assessed_at,
              source: "supabase"
            };
          });
        })
        .catch(function () {
          supabaseSaving = false;
          showBanner(
            "Supabase saving is not set up yet: the <code>sidewalk_assessments</code> table was not found. " +
            "Assessments will save in this browser only until you run <code>sql/assessments.sql</code> (see README)."
          );
        });
    })
    .then(function () {
      // Merge in any assessments saved locally in this browser.
      var local = loadLocalAssessments();
      Object.keys(local).forEach(function (grid) {
        if (!assessments[grid]) assessments[grid] = local[grid];
      });
      loadingEl.style.display = "none";
      renderLayer();
      map.fitBounds(L.geoJSON(parcels).getBounds().pad(0.1));
    })
    .catch(function (err) {
      loadingEl.textContent = "Could not load parcels from Supabase (" + err.message + "). Check the key in config.js and that the parcels table exists.";
    });
})();
