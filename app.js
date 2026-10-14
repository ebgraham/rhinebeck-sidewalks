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

  // Condition is a 1-5 score, 5 = best. Map colors run red (1) to green (5).
  var CONDITION_COLORS = {
    1: "#d73027",
    2: "#f46d43",
    3: "#fdae61",
    4: "#a6d96a",
    5: "#2ca25f"
  };
  var CONDITION_LABELS = {
    1: "1 (worst)",
    2: "2",
    3: "3",
    4: "4",
    5: "5 (best)"
  };
  var CONDITION_TEXT_COLORS = {
    1: "#ffffff",
    2: "#ffffff",
    3: "#1a1a1a",
    4: "#1a1a1a",
    5: "#ffffff"
  };
  var SURFACES = ["Bluestone", "Concrete", "Asphalt", "Stone Aggregate", "Gravel", "Missing", "Other"];
  var ISSUES = ["Lifted", "Cracked", "Worn", "Grass/Dirt", "Clearance", "Other"];

  // MapLibre + OpenFreeMap vector tiles: the base map is vectors, so it
  // stays crisp at every zoom (no upscaled raster tiles), the Liberty style
  // has no terrain shading, and no API key is needed.
  var map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: [-73.911, 41.926],
    zoom: 15,
    maxZoom: 19
  });
  map.on("load", function () {
    map.addSource("parcels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": ["get", "fillColor"], "fill-opacity": ["get", "fillOpacity"] } });
    map.addLayer({ id: "parcels-line", type: "line", source: "parcels", paint: { "line-color": ["get", "lineColor"], "line-width": ["get", "lineWidth"] } });
    map.addSource("loc-accuracy", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "loc-accuracy-fill", type: "fill", source: "loc-accuracy", paint: { "fill-color": "#1a6bff", "fill-opacity": 0.12 } });
    map.addLayer({ id: "loc-accuracy-line", type: "line", source: "loc-accuracy", paint: { "line-color": "#1a6bff", "line-width": 1 } });
    map.on("click", "parcels-fill", function (e) {
      if (e.features && e.features.length) selectParcel(e.features[0].properties.parcelgrid);
    });
    map.on("mouseenter", "parcels-fill", function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "parcels-fill", function () { map.getCanvas().style.cursor = ""; });
    if (parcels.length) renderLayer();
  });

  // GPS: locate the user and optionally follow them (phone-friendly).
  // Geolocation needs HTTPS and the user's permission.
  var locateBtn = document.getElementById("locateBtn");
  var showPanelBtn = document.getElementById("showPanelBtn");
  var panel = document.getElementById("panel");
  var panelToggle = document.getElementById("panelToggle");
  var locMarker = null;
  var watchId = null;
  var locating = false, following = false;

  function accuracyPolygon(lng, lat, radiusMeters) {
    var points = [];
    for (var i = 0; i <= 64; i++) {
      var angle = (i / 64) * Math.PI * 2;
      var dx = radiusMeters * Math.cos(angle);
      var dy = radiusMeters * Math.sin(angle);
      var dLat = dy / 111320;
      var dLng = dx / (111320 * Math.cos(lat * Math.PI / 180));
      points.push([lng + dLng, lat + dLat]);
    }
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [points] } };
  }

  function stopLocating() {
    locating = false;
    following = false;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    locateBtn.setAttribute("aria-label", "Locate me"); locateBtn.title = "Locate me";
    locateBtn.classList.remove("active");
    try { localStorage.setItem("rhinebeck-locate-enabled", "0"); } catch (e) {}
    if (locMarker) { locMarker.remove(); locMarker = null; }
    if (map.getSource("loc-accuracy")) {
      map.getSource("loc-accuracy").setData({ type: "FeatureCollection", features: [] });
    }
  }

  function startLocating() {
    if (!("geolocation" in navigator)) { alert("Geolocation is not supported by this browser."); return; }
    locating = true;
    following = true;
    locateBtn.setAttribute("aria-label", "Stop following"); locateBtn.title = "Stop following";
    locateBtn.classList.add("active");
    try { localStorage.setItem("rhinebeck-locate-enabled", "1"); } catch (e) {}
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
  }

  function onPosition(pos) {
    var lng = pos.coords.longitude, lat = pos.coords.latitude, acc = pos.coords.accuracy;
    if (!locMarker) {
      var dot = document.createElement("div");
      dot.style.cssText = "width:16px;height:16px;border-radius:50%;background:#1a6bff;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.4);";
      locMarker = new maplibregl.Marker({ element: dot }).setLngLat([lng, lat]).addTo(map);
    } else {
      locMarker.setLngLat([lng, lat]);
    }
    if (map.getSource("loc-accuracy")) {
      map.getSource("loc-accuracy").setData({ type: "FeatureCollection", features: [accuracyPolygon(lng, lat, acc)] });
    }
    if (following) map.panTo([lng, lat]);
  }

  function onPositionError(err) {
    stopLocating();
    alert("Could not get your location: " + err.message + ". Make sure location permission is allowed for this site (it needs HTTPS).");
  }

  locateBtn.addEventListener("click", function () {
    if (!locating) {
      startLocating();
    } else if (following) {
      stopLocating();
    } else {
      following = true;
      locateBtn.setAttribute("aria-label", "Stop following"); locateBtn.title = "Stop following";
      locateBtn.classList.add("active");
    }
  });

  // If the user left location on and the browser still grants permission,
  // resume following without asking again. If permission is only "prompt"
  // (e.g. local file:// pages, which never remember grants), wait for a tap.
  try {
    if (localStorage.getItem("rhinebeck-locate-enabled") === "1" && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "geolocation" }).then(function (result) {
        if (result.state === "granted") startLocating();
      }).catch(function () {});
    }
  } catch (e) {}

  // Dragging the map manually pauses following but keeps the dot updating.
  map.on("dragstart", function () {
    if (locating && following) {
      following = false;
      locateBtn.setAttribute("aria-label", "Follow me"); locateBtn.title = "Follow me";
      locateBtn.classList.remove("active");
    }
  });

  // Collapsible panel: on mobile the panel can cover the map, so it can be
  // hidden entirely and reopened from the map. Hiding slides the panel
  // away (width on desktop, height on mobile) instead of vanishing.
  function syncMapDuringTransition() {
    var start = performance.now();
    function frame(now) {
      map.resize();
      if (now - start < 400) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  // Once the slide finishes, drop the collapsed panel from layout/tab order.
  panel.addEventListener("transitionend", function () {
    if (panel.classList.contains("collapsed")) panel.classList.add("hidden");
    map.resize();
  });
  function hidePanel() {
    panel.classList.add("collapsed");
    showPanelBtn.style.display = "block";
    syncMapDuringTransition();
  }
  function showPanel() {
    panel.classList.remove("hidden");
    // Force a reflow so the slide-in animates instead of snapping.
    void panel.offsetWidth;
    panel.classList.remove("collapsed");
    showPanelBtn.style.display = "none";
    syncMapDuringTransition();
  }
  panelToggle.addEventListener("click", hidePanel);
  showPanelBtn.addEventListener("click", showPanel);

  var parcels = []; // GeoJSON features
  var assessments = {}; // parcelgrid -> {condition, notes, assessed_at, source}
  var supabaseSaving = false;
  var activeFilter = "all";
  var selectedGrid = null;
  var selectedCondition = null; // condition picked in the form (1-5), null = none

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
    var counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    var assessed = 0;
    Object.keys(assessments).forEach(function (grid) {
      var c = assessments[grid].condition;
      if (counts.hasOwnProperty(c)) {
        counts[c] += 1;
        assessed += 1;
      }
    });
    var parts = ["<b>" + parcels.length + "</b> parcels", "<b>" + assessed + "</b> assessed"];
    [5, 4, 3, 2, 1].forEach(function (c) {
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
    if (!map.getSource("parcels")) return; // map style not loaded yet; the load handler re-renders
    var feats = visibleFeatures().map(function (f) {
      var s = styleFor(f);
      var props = Object.assign({}, f.properties, {
        fillColor: s.fillColor, fillOpacity: s.fillOpacity,
        lineColor: s.color, lineWidth: s.weight
      });
      return { type: "Feature", properties: props, geometry: f.geometry };
    });
    map.getSource("parcels").setData({ type: "FeatureCollection", features: feats });
    renderStats();
  }

  // Bounding box of GeoJSON features as [[minLng, minLat], [maxLng, maxLat]].
  function boundsOfFeatures(features) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function walk(coords) {
      if (typeof coords[0] === "number") {
        if (coords[0] < minX) minX = coords[0];
        if (coords[0] > maxX) maxX = coords[0];
        if (coords[1] < minY) minY = coords[1];
        if (coords[1] > maxY) maxY = coords[1];
      } else {
        coords.forEach(walk);
      }
    }
    features.forEach(function (f) { walk(f.geometry.coordinates); });
    return [[minX, minY], [maxX, maxY]];
  }

  function selectParcel(grid) {
    selectedGrid = grid;
    if (panel.classList.contains("hidden")) showPanel();
    if (typeof closeSuggestions === "function") closeSuggestions();
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
      "<h2>" + escapeHtml(props.address || "No address on file") + "</h2>" +
      '<div class="meta">Parcel: ' + escapeHtml(props.printkey || grid) +
      "<br>Grid ID: " + escapeHtml(grid) +
      "<br>Lot size: " + areaSqft + " sq ft (" + areaAcres + " acres)" +
      ((props.address_count > 1 && props.addresses)
        ? "<br><details><summary>All " + props.address_count + " addresses</summary>" + escapeHtml(props.addresses) + "</details>"
        : "") +
      "</div>" +
      '<label>Condition (1 = worst, 5 = best)</label>' +
      '<div class="condRow">' +
      [1, 2, 3, 4, 5].map(function (n) {
        return '<button type="button" class="condBox' + (String(a.condition) === String(n) ? " selected" : "") + '" data-condition="' + n + '" style="background:' + CONDITION_COLORS[n] + ';color:' + CONDITION_TEXT_COLORS[n] + '">' + n + "</button>";
      }).join("") +
      "</div>" +
      '<label>Surface (tap all that apply)</label>' +
      optionGroup("surface", SURFACES, a.surface, "surfaceBox") +
      '<label>Issues (tap all that apply)</label>' +
      optionGroup("issue", ISSUES, a.issues, "issueBox") +
      '<label>Priority</label>' +
      '<div class="optRow">' +
      '<button type="button" class="optBox priorityBox' + (a.priority_fix ? " selected" : "") + '" id="priorityBox">Priority Fix</button>' +
      "</div>" +
      '<label for="notesInput">Notes</label>' +
      '<textarea id="notesInput" placeholder="..."></textarea>' +
      '<button class="btn" id="saveBtn" type="button">Save assessment</button> ' +
      '<button class="btn secondary" id="clearBtn" type="button">Clear</button>' +
      '<div id="saveStatus"></div>';
    document.getElementById("notesInput").value = a.notes || "";
    var saveBtn = document.getElementById("saveBtn");
    // Condition starts at the saved value (if any); Save stays disabled
    // until a box is picked.
    var condNum = Number(a.condition);
    selectedCondition = (condNum >= 1 && condNum <= 5) ? condNum : null;
    saveBtn.disabled = selectedCondition === null;
    document.querySelectorAll(".condBox").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectedCondition = parseInt(btn.getAttribute("data-condition"), 10);
        document.querySelectorAll(".condBox").forEach(function (b) { b.classList.remove("selected"); });
        btn.classList.add("selected");
        saveBtn.disabled = false;
      });
    });
    document.querySelectorAll(".optBox").forEach(function (btn) {
      btn.addEventListener("click", function () {
        btn.classList.toggle("selected");
      });
    });
    saveBtn.addEventListener("click", function () {
      var surface = selectedValues("surface");
      var issues = selectedValues("issue");
      var priorityFix = document.getElementById("priorityBox").classList.contains("selected");
      var notes = document.getElementById("notesInput").value.trim();
      saveAssessment(grid, selectedCondition, surface, issues, priorityFix, notes);
    });
    document.getElementById("clearBtn").addEventListener("click", function () {
      if (assessments[grid]) {
        // Destructive: confirm before deleting the saved assessment.
        if (confirm("Clear the saved assessment for this parcel?")) saveAssessment(grid, null);
      } else {
        resetForm();
      }
    });
    // Zoom to the parcel.
    map.fitBounds(boundsOfFeatures([feature]), { padding: 60, maxZoom: 19 });
  }

  // A row of toggle boxes for a multi-select group (Surface / Issues).
  // All boxes in a group share one light color; selected ones get a dark
  // border. cls picks the group's color.
  function optionGroup(name, options, selected, cls) {
    selected = selected || [];
    return '<div class="optRow">' + options.map(function (opt) {
      return '<button type="button" class="optBox ' + cls + (selected.indexOf(opt) !== -1 ? " selected" : "") + '" data-name="' + name + '" data-value="' + escapeHtml(opt) + '">' + escapeHtml(opt) + "</button>";
    }).join("") + "</div>";
  }

  // Values of the currently selected boxes in one group.
  function selectedValues(name) {
    var out = [];
    document.querySelectorAll('.optBox[data-name="' + name + '"].selected').forEach(function (el) { out.push(el.getAttribute("data-value")); });
    return out;
  }

  function setStatus(text, cls) {
    var el = document.getElementById("saveStatus");
    if (el) {
      el.textContent = text;
      el.className = cls || "";
    }
  }

  // Reset the assessment form to "Not assessed" with everything cleared
  // and a disabled Save button (used after a successful Clear).
  function resetForm() {
    selectedCondition = null;
    document.querySelectorAll(".condBox, .optBox").forEach(function (el) { el.classList.remove("selected"); });
    var nt = document.getElementById("notesInput");
    if (nt) nt.value = "";
    var sb = document.getElementById("saveBtn");
    if (sb) sb.disabled = true;
  }

  function saveAssessment(grid, condition, surface, issues, priorityFix, notes) {
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
          resetForm();
          setStatus("Assessment cleared.", "ok");
        }).catch(function () {
          setStatus("Could not clear in Supabase. The record may still exist.", "err");
        });
      } else {
        delete assessments[grid];
        saveLocalAssessments();
        renderLayer();
        resetForm();
        setStatus("Assessment cleared (was stored locally).", "ok");
      }
      return;
    }
    var record = {
      parcelgrid: grid,
      condition: condition,
      surface: surface || [],
      issues: issues || [],
      priority_fix: !!priorityFix,
      notes: notes || null,
      assessed_at: new Date().toISOString()
    };
    if (supabaseSaving) {
      // on_conflict=parcelgrid is required: without it PostgREST targets the
      // primary key for the merge, so re-saving an assessed parcel fails with
      // a 409 duplicate-key error instead of updating the row.
      fetch(BASE + "/rest/v1/sidewalk_assessments?on_conflict=parcelgrid", {
        method: "POST",
        headers: Object.assign(apiHeaders(), { Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify(record)
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        assessments[grid] = Object.assign({}, record, { source: "supabase" });
        renderLayer();
        setStatus("Saved.", "ok");
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

  // Normalize for search: lowercase, split into words, expand common
  // street-suffix and direction words so "2 Mill Road" matches "2 MILL RD"
  // and "N" matches "NORTH". Digits (parcel IDs) pass through unchanged.
  var SUFFIX_MAP = {
    road: "rd", street: "st", avenue: "av", drive: "dr", lane: "ln",
    court: "ct", place: "pl", boulevard: "blvd", parkway: "pkwy",
    trail: "trl", circle: "cir", loop: "lp", park: "pk",
    north: "n", south: "s", east: "e", west: "w"
  };
  function normalizeSearch(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter(Boolean).map(function (w) { return SUFFIX_MAP[w] || w; }).join("");
  }

  // Flat index of every address in the database, including secondary
  // addresses on multi-address parcels.
  var addressIndex = null;
  function getAddressIndex() {
    if (!addressIndex && parcels.length) {
      addressIndex = [];
      parcels.forEach(function (f) {
        var p = f.properties;
        var list = (p.address_count > 1 && p.addresses) ? p.addresses.split("; ")
          : (p.address ? [p.address] : []);
        list.forEach(function (addr) { addressIndex.push({ label: addr, grid: p.parcelgrid }); });
      });
    }
    return addressIndex || [];
  }

  // Autocomplete dropdown for the address search.
  var suggEl = document.getElementById("suggestions");
  var searchInput = document.getElementById("searchInput");
  var currentMatches = [];
  var suggIndex = -1;

  function closeSuggestions() {
    suggEl.style.display = "none";
    suggIndex = -1;
    currentMatches = [];
  }

  function highlightSugg() {
    var items = suggEl.querySelectorAll(".sugg");
    items.forEach(function (el, i) { el.classList.toggle("selected", i === suggIndex); });
  }

  searchInput.addEventListener("input", function () {
    var q = normalizeSearch(searchInput.value);
    if (q.length < 2) { closeSuggestions(); return; }
    var matches = [];
    var seen = {};
    getAddressIndex().forEach(function (a) {
      if (matches.length >= 8) return;
      if (!seen[a.label] && normalizeSearch(a.label).indexOf(q) !== -1) {
        seen[a.label] = true;
        matches.push(a);
      }
    });
    currentMatches = matches;
    suggIndex = -1;
    suggEl.innerHTML = "";
    if (!matches.length) { closeSuggestions(); return; }
    matches.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "sugg";
      div.textContent = m.label;
      div.addEventListener("mousedown", function (ev) {
        ev.preventDefault(); // fire before the input loses focus
        searchInput.value = m.label;
        closeSuggestions();
        selectParcel(m.grid);
      });
      suggEl.appendChild(div);
    });
    suggEl.style.display = "block";
  });

  searchInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { closeSuggestions(); return; }
    if (suggEl.style.display !== "block") return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      suggIndex = Math.min(suggIndex + 1, currentMatches.length - 1);
      highlightSugg();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      suggIndex = Math.max(suggIndex - 1, 0);
      highlightSugg();
    } else if (ev.key === "Enter" && suggIndex >= 0 && currentMatches[suggIndex]) {
      ev.preventDefault();
      var m = currentMatches[suggIndex];
      searchInput.value = m.label;
      closeSuggestions();
      selectParcel(m.grid);
    }
  });

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest("#searchWrap")) closeSuggestions();
  });

  document.getElementById("searchBtn").addEventListener("click", function () {
    var q = normalizeSearch(searchInput.value);
    if (!q) return;
    closeSuggestions();
    for (var i = 0; i < parcels.length; i++) {
      var p = parcels[i].properties;
      if (normalizeSearch(p.printkey).indexOf(q) !== -1 || normalizeSearch(p.parcelgrid).indexOf(q) !== -1 || normalizeSearch(p.address).indexOf(q) !== -1 || normalizeSearch(p.addresses).indexOf(q) !== -1) {
        selectParcel(p.parcelgrid);
        return;
      }
    }
    alert("No parcel matches that ID or address.");
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
    var lines = ["parcelgrid,printkey,address,addresses,condition,surface,issues,priority_fix,notes,assessed_at,source"];
    var byGrid = {};
    parcels.forEach(function (f) { byGrid[f.properties.parcelgrid] = f.properties; });
    Object.keys(assessments).forEach(function (grid) {
      var a = assessments[grid];
      var csv = [grid, byGrid[grid] ? byGrid[grid].printkey || "" : "", byGrid[grid] ? byGrid[grid].address || "" : "", byGrid[grid] ? byGrid[grid].addresses || "" : "", a.condition != null ? String(a.condition) : "", (a.surface || []).join("; "), (a.issues || []).join("; "), a.priority_fix ? "true" : "false", (a.notes || "").replace(/"/g, '""'), a.assessed_at || "", a.source || ""];
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
      return fetchAll("/rest/v1/sidewalk_assessments?select=parcelgrid,condition,surface,issues,priority_fix,notes,assessed_at&order=parcelgrid")
        .then(function (arows) {
          supabaseSaving = true;
          arows.forEach(function (r) {
            assessments[r.parcelgrid] = {
              condition: r.condition,
              surface: r.surface || [],
              issues: r.issues || [],
              priority_fix: !!r.priority_fix,
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
      map.fitBounds(boundsOfFeatures(parcels), { padding: 40 });
    })
    .catch(function (err) {
      loadingEl.textContent = "Could not load parcels from Supabase (" + err.message + "). Check the key in config.js and that the parcels table exists.";
    });
})();
