// Rhinebeck Village sidewalk survey map.
// Reads parcels and sidewalk segments from Supabase (PostgREST) and saves
// segment assessments back to Supabase when the segment tables exist
// (see sql/segments.sql). Assessments live on sidewalk segments: one per
// parcel frontage on one street. If Supabase saving is not set up,
// assessments fall back to localStorage.

(function () {
  "use strict";

  var cfg = window.SURVEY_CONFIG || {};
  var BASE = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
  var KEY = cfg.SUPABASE_ANON_KEY || "";
  var KEY_MISSING = !KEY || KEY === "PASTE_YOUR_PUBLISHABLE_KEY_HERE";

  // Bump this (and the ?v= on the script tags in index.html) on every
  // app.js change so browsers fetch the new file instead of a cached one.
  var APP_VERSION = 15;
  var versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.textContent = "v" + APP_VERSION;

  // Condition is a 1-4 score: 1 = Damaged (worst) through 4 = Excellent
  // (best). Map colors run red (1) to green (4).
  var CONDITION_COLORS = {
    1: "#d73027",
    2: "#f46d43",
    3: "#a6d96a",
    4: "#2ca25f"
  };
  var CONDITION_LABELS = {
    1: "Damaged",
    2: "Deficient",
    3: "Good",
    4: "Excellent"
  };
  var CONDITION_TEXT_COLORS = {
    1: "#ffffff",
    2: "#ffffff",
    3: "#1a1a1a",
    4: "#ffffff"
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
    map.addSource("segments", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // NOTE: line-cap and line-join are LAYOUT properties in MapLibre, not
    // paint. Putting them in paint fails style validation and the whole
    // layer is rejected (this was the missing-lines bug).
    map.addLayer({ id: "segments-line", type: "line", source: "segments", layout: { visibility: "none", "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "lineColor"], "line-width": ["get", "lineWidth"] } });
    map.on("mouseenter", "segments-line", function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "segments-line", function () { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "parcels-fill", function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "parcels-fill", function () { map.getCanvas().style.cursor = ""; });
    // Click handlers per layer (the layer-click mechanism is the proven
    // one here). Both layers are visible now, so both handlers fire on
    // a line tap — the parcel handler defers when the tap also hits a
    // sidewalk line, so the line wins.
    map.on("click", "segments-line", function (e) {
      if (e.features && e.features.length) selectSegment(e.features[0].properties.id);
    });
    map.on("click", "parcels-fill", function (e) {
      if (map.queryRenderedFeatures(e.point, { layers: ["segments-line"] }).length) return;
      if (e.features && e.features.length) selectParcel(e.features[0].properties.parcelgrid);
    });
    // Tapping empty map (no parcel, no segment) dismisses the selection
    // and hides the panel.
    map.on("click", function (e) {
      var hits = map.queryRenderedFeatures(e.point, { layers: ["parcels-fill", "segments-line"] });
      if (!hits.length && (selectedGrid !== null || selectedSegmentId !== null)) {
        selectedGrid = null;
        selectedSegmentId = null;
        renderLayer();
        hidePanel();
      }
    });
    map.addSource("loc-accuracy", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "loc-accuracy-fill", type: "fill", source: "loc-accuracy", paint: { "fill-color": "#1a6bff", "fill-opacity": 0.12 } });
    map.addLayer({ id: "loc-accuracy-line", type: "line", source: "loc-accuracy", paint: { "line-color": "#1a6bff", "line-width": 1 } });
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
    // PERMISSION_DENIED is usually a saved "Don't Allow" — the browser will
    // not re-prompt, so the user must re-enable it in site settings. A
    // non-HTTPS page can never get location at all.
    var msg;
    if (err.code === 1) {
      if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        msg = "This page is not served over HTTPS, so the browser blocks location. Open the deployed HTTPS site instead of a local file or HTTP address.";
      } else {
        msg = "Location permission was denied for this site, and the browser will not ask again. Re-enable it in your browser's site settings for this site (on iPhone: Settings > Safari > Location, or the share / lock menu > Website Settings), then tap Locate again.";
      }
    } else if (err.code === 2) {
      msg = "Position unavailable. Try again outside with a clearer view of the sky.";
    } else {
      msg = "Location timed out. Try again.";
    }
    alert("Could not get your location: " + msg);
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

  // Global controls (view toggle, filters, search, export) live in their
  // own pop-out panel so the side panel stays parcel-specific. The
  // Settings button on the map is always visible and toggles it.
  var globalBtn = document.getElementById("globalBtn");
  var globalPanel = document.getElementById("globalPanel");
  globalBtn.addEventListener("click", function () {
    var opening = globalPanel.classList.contains("hidden");
    globalPanel.classList.toggle("hidden");
    globalBtn.classList.toggle("active", opening);
    globalBtn.setAttribute("aria-label", opening ? "Hide survey options" : "Show survey options");
    globalBtn.title = opening ? "Hide survey options" : "Show survey options";
  });

  // Tapping anywhere outside the pop-out (and its button) dismisses it.
  document.addEventListener("click", function (e) {
    if (globalPanel.classList.contains("hidden")) return;
    if (globalPanel.contains(e.target) || globalBtn.contains(e.target)) return;
    globalPanel.classList.add("hidden");
    globalBtn.classList.remove("active");
    globalBtn.setAttribute("aria-label", "Show survey options");
    globalBtn.title = "Show survey options";
  });

  var parcels = []; // GeoJSON features
  var segments = []; // GeoJSON features: one per (parcel, street)
  var segmentsByParcel = {}; // parcelgrid -> [segment features]
  var segmentById = {}; // segment id -> feature
  var segAssessments = {}; // segment id -> {condition, surface, issues, priority_fix, notes, assessed_at, source}
  var supabaseSaving = false;
  var segmentsLoaded = false;
  // Parcels are always displayed and always selectable. The Sidewalks
  // layer (colored segment lines) is toggleable from the Settings pop-out
  // and defaults to on. Unassessed segment lines are hidden by default;
  // a Settings toggle shows them.
  var showSidewalks = true;
  var showUnassessed = false;
  var activeFilter = "all";
  var selectedGrid = null;
  var selectedSegmentId = null;
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
      return JSON.parse(localStorage.getItem("rhinebeck-segment-assessments") || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveLocalAssessments() {
    var local = {};
    Object.keys(segAssessments).forEach(function (id) {
      if (segAssessments[id].source === "local") local[id] = segAssessments[id];
    });
    localStorage.setItem("rhinebeck-segment-assessments", JSON.stringify(local));
  }

  // Parcels: blue outline always. Selected parcel gets a light blue fill
  // (keeping the usual blue border); parcels with at least one assessed
  // segment get a very light blue fill. Unassessed, unselected parcels
  // stay visually unfilled (1% opacity keeps the fill layer tappable).
  function styleFor(feature) {
    var isSelected = feature.properties.parcelgrid === selectedGrid;
    return {
      color: "#3388ff",
      weight: isSelected ? 3 : 1
    };
  }

  function parcelFillFor(feature, assessedParcels) {
    var grid = feature.properties.parcelgrid;
    if (grid === selectedGrid) return { fillColor: "#93c5fd", fillOpacity: 0.45 };
    if (assessedParcels[grid]) return { fillColor: "#dbeafe", fillOpacity: 0.55 };
    return { fillColor: "#3388ff", fillOpacity: 0.01 };
  }

  // Segment lines: condition color when assessed, gray when not.
  function segmentStyleFor(feature) {
    var a = segAssessments[feature.properties.id];
    var isSelected = feature.properties.id === selectedSegmentId;
    if (a && CONDITION_COLORS[a.condition]) {
      return { color: CONDITION_COLORS[a.condition], width: isSelected ? 7 : 4 };
    }
    return { color: "#4b5563", width: isSelected ? 7 : 4 };
  }

  function segmentMatchesFilter(seg) {
    var has = !!segAssessments[seg.properties.id];
    if (activeFilter === "assessed") return has;
    if (activeFilter === "unassessed") return !has;
    return true;
  }

  function renderStats() {
    var counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    var assessed = 0;
    Object.keys(segAssessments).forEach(function (id) {
      var c = segAssessments[id].condition;
      if (counts.hasOwnProperty(c)) {
        counts[c] += 1;
        assessed += 1;
      }
    });
    var parts = ["<b>" + segments.length + "</b> sidewalk segments", "<b>" + assessed + "</b> assessed"];
    [4, 3, 2, 1].forEach(function (c) {
      parts.push(
        '<span><span class="dot" style="background:' + CONDITION_COLORS[c] + '"></span>' +
        CONDITION_LABELS[c] + ": <b>" + counts[c] + "</b></span>"
      );
    });
    statsEl.innerHTML = parts.join(" ");
  }

  // Parcels shown under the current filter: a parcel shows when it has at
  // least one segment matching the filter (or, for "Not assessed", when
  // none of its segments are assessed — including parcels with no segments).
  function visibleFeatures() {
    return parcels.filter(function (f) {
      var segs = segmentsByParcel[f.properties.parcelgrid] || [];
      if (activeFilter === "assessed") return segs.some(function (s) { return !!segAssessments[s.properties.id]; });
      if (activeFilter === "unassessed") return !segs.some(function (s) { return !!segAssessments[s.properties.id]; });
      return true;
    });
  }

  function renderLayer() {
    if (!map.getSource("parcels")) return; // map style not loaded yet; the load handler re-renders
    // Parcels with at least one assessed segment get a very light blue fill.
    var assessedParcels = {};
    segments.forEach(function (seg) {
      if (segAssessments[seg.properties.id]) assessedParcels[seg.properties.parcelgrid] = true;
    });
    var feats = visibleFeatures().map(function (f) {
      var s = styleFor(f);
      var fill = parcelFillFor(f, assessedParcels);
      var props = Object.assign({}, f.properties, {
        fillColor: fill.fillColor, fillOpacity: fill.fillOpacity,
        lineColor: s.color,
        lineWidth: s.weight
      });
      return { type: "Feature", properties: props, geometry: f.geometry };
    });
    map.getSource("parcels").setData({ type: "FeatureCollection", features: feats });
    // Segments: visible only when the Sidewalks layer is on, and only
    // matching the filter. Unassessed lines are hidden unless the
    // Settings toggle shows them.
    if (map.getSource("segments")) {
      var segFeats = (showSidewalks ? segments.filter(segmentMatchesFilter) : [])
        .filter(function (f) { return showUnassessed || segAssessments[f.properties.id]; })
        .map(function (f) {
          var s = segmentStyleFor(f);
          var props = Object.assign({}, f.properties, { lineColor: s.color, lineWidth: s.width });
          return { type: "Feature", properties: props, geometry: f.geometry };
        });
      map.getSource("segments").setData({ type: "FeatureCollection", features: segFeats });
    }
    if (map.getLayer("parcels-fill")) {
      map.setLayoutProperty("parcels-fill", "visibility", "visible");
    }
    if (map.getLayer("parcels-line")) {
      map.setLayoutProperty("parcels-line", "visibility", "visible");
    }
    if (map.getLayer("segments-line")) {
      map.setLayoutProperty("segments-line", "visibility", showSidewalks ? "visible" : "none");
    }
    renderStats();
  }

  // The Sidewalks layer (segment lines) is toggleable from the Survey
  // Options pop-out. Parcels are always on. Sidewalks needs the
  // segments table; if it failed to load, the button is hidden and the
  // layer stays off.
  function setLayer(which, on) {
    if (which !== "sidewalks") return;
    if (on && !segmentsLoaded) return;
    showSidewalks = on;
    document.querySelectorAll("#viewToggle button").forEach(function (b) {
      b.classList.toggle("active", showSidewalks);
    });
    renderLayer();
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

  // Parcel panel: parcel details plus the list of its sidewalk segments.
  // Tapping a segment opens that segment's assessment form.
  function selectParcel(grid) {
    selectedGrid = grid;
    selectedSegmentId = null;
    if (panel.classList.contains("hidden")) showPanel();
    if (typeof closeSuggestions === "function") closeSuggestions();
    renderLayer();
    var feature = null;
    for (var i = 0; i < parcels.length; i++) {
      if (parcels[i].properties.parcelgrid === grid) { feature = parcels[i]; break; }
    }
    if (!feature) return;
    var props = feature.properties;
    var segs = segmentsByParcel[grid] || [];
    var listHtml = segs.length ? segs.map(function (s) {
      var sa = segAssessments[s.properties.id];
      var status = (sa && CONDITION_COLORS[sa.condition])
        ? '<span class="segDot" style="background:' + CONDITION_COLORS[sa.condition] + '"></span>Condition ' + sa.condition
        : '<span class="segDot" style="background:#4b5563"></span>Not assessed';
      return '<button type="button" class="segRow" data-segment="' + s.properties.id + '"><span>' + escapeHtml(s.properties.street_name) + "</span><span>" + status + "</span></button>";
    }).join("") : '<p class="segEmpty">No sidewalk segments — this parcel does not front a street in the county roads data.</p>';
    panelEl.innerHTML =
      "<h2>" + escapeHtml(props.address || "No address on file") + "</h2>" +
      '<div class="meta">Parcel: ' + escapeHtml(props.printkey || grid) +
      "<br>Grid ID: " + escapeHtml(grid) +
      ((props.address_count > 1 && props.addresses)
        ? "<br><details><summary>All " + props.address_count + " addresses</summary>" + escapeHtml(props.addresses) + "</details>"
        : "") +
      "</div>" +
      "<label>Sidewalks</label>" +
      listHtml;
    panelEl.querySelectorAll(".segRow").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectSegment(parseInt(btn.getAttribute("data-segment"), 10));
      });
    });
    // Zoom to the parcel.
    map.fitBounds(boundsOfFeatures([feature]), { padding: 60, maxZoom: 19 });
  }

  // Segment panel: the assessment form for one sidewalk segment.
  function selectSegment(id) {
    var seg = segmentById[id];
    if (!seg) return;
    selectedSegmentId = id;
    var grid = seg.properties.parcelgrid;
    selectedGrid = grid;
    if (panel.classList.contains("hidden")) showPanel();
    if (typeof closeSuggestions === "function") closeSuggestions();
    renderLayer();
    var parcelProps = null;
    for (var i = 0; i < parcels.length; i++) {
      if (parcels[i].properties.parcelgrid === grid) { parcelProps = parcels[i].properties; break; }
    }
    var a = segAssessments[id] || {};
    panelEl.innerHTML =
      '<button type="button" class="btn secondary" id="backBtn">\u2190 All sidewalks on this parcel</button>' +
      "<h2>" + escapeHtml((parcelProps && parcelProps.address) || "No address on file") + "</h2>" +
      '<div class="meta">Sidewalk on ' + escapeHtml(seg.properties.street_name) +
      "<br>Parcel: " + escapeHtml((parcelProps && parcelProps.printkey) || grid) + "</div>" +
      '<label>Condition</label>' +
      '<div class="condRow">' +
      [1, 2, 3, 4].map(function (n) {
        return '<div class="condItem"><button type="button" class="condBox' + (String(a.condition) === String(n) ? " selected" : "") + '" data-condition="' + n + '" style="background:' + CONDITION_COLORS[n] + ';color:' + CONDITION_TEXT_COLORS[n] + '">' + n + "</button><span class=\"condLabel\">" + CONDITION_LABELS[n] + "</span></div>";
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
    document.getElementById("backBtn").addEventListener("click", function () {
      selectParcel(grid);
    });
    var saveBtn = document.getElementById("saveBtn");
    // Condition starts at the saved value (if any); Save stays disabled
    // until a box is picked.
    var condNum = Number(a.condition);
    selectedCondition = (condNum >= 1 && condNum <= 4) ? condNum : null;
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
      saveAssessment(id, selectedCondition, surface, issues, priorityFix, notes);
    });
    document.getElementById("clearBtn").addEventListener("click", function () {
      if (segAssessments[id]) {
        // Destructive: confirm before deleting the saved assessment.
        if (confirm("Clear the saved assessment for this sidewalk?")) saveAssessment(id, null);
      } else {
        resetForm();
      }
    });
    // Zoom to the segment.
    map.fitBounds(boundsOfFeatures([seg]), { padding: 60, maxZoom: 19 });
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

  function saveAssessment(segmentId, condition, surface, issues, priorityFix, notes) {
    if (!condition) {
      // Clearing: delete from Supabase if saving is on, else drop local copy.
      if (supabaseSaving) {
        fetch(BASE + "/rest/v1/segment_assessments?segment_id=eq." + encodeURIComponent(segmentId), {
          method: "DELETE",
          headers: apiHeaders()
        }).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          delete segAssessments[segmentId];
          saveLocalAssessments();
          renderLayer();
          resetForm();
          setStatus("Assessment cleared.", "ok");
        }).catch(function () {
          setStatus("Could not clear in Supabase. The record may still exist.", "err");
        });
      } else {
        delete segAssessments[segmentId];
        saveLocalAssessments();
        renderLayer();
        resetForm();
        setStatus("Assessment cleared (was stored locally).", "ok");
      }
      return;
    }
    var record = {
      segment_id: segmentId,
      condition: condition,
      surface: surface || [],
      issues: issues || [],
      priority_fix: !!priorityFix,
      notes: notes || null,
      assessed_at: new Date().toISOString()
    };
    if (supabaseSaving) {
      // on_conflict=segment_id is required: without it PostgREST targets the
      // primary key for the merge, so re-saving an assessed segment fails with
      // a 409 duplicate-key error instead of updating the row.
      fetch(BASE + "/rest/v1/segment_assessments?on_conflict=segment_id", {
        method: "POST",
        headers: Object.assign(apiHeaders(), { Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify(record)
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        segAssessments[segmentId] = Object.assign({}, record, { source: "supabase" });
        renderLayer();
        // Back to the parcel page: the segment list shows the updated
        // condition for this sidewalk, which confirms the save.
        var seg = segmentById[segmentId];
        if (seg) selectParcel(seg.properties.parcelgrid);
      }).catch(function () {
        segAssessments[segmentId] = Object.assign({}, record, { source: "local" });
        saveLocalAssessments();
        renderLayer();
        setStatus("Saved locally only — Supabase write failed.", "warn");
      });
    } else {
      segAssessments[segmentId] = Object.assign({}, record, { source: "local" });
      saveLocalAssessments();
      renderLayer();
      setStatus("Saved locally. Run the segments SQL to enable Supabase saving (see README).", "warn");
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
    var lines = ["segment_id,parcelgrid,printkey,address,street_name,condition,surface,issues,priority_fix,notes,assessed_at,source"];
    var byGrid = {};
    parcels.forEach(function (f) { byGrid[f.properties.parcelgrid] = f.properties; });
    Object.keys(segAssessments).forEach(function (id) {
      var a = segAssessments[id];
      var seg = segmentById[id];
      var grid = seg ? seg.properties.parcelgrid : "";
      var csv = [id, grid, byGrid[grid] ? byGrid[grid].printkey || "" : "", byGrid[grid] ? byGrid[grid].address || "" : "", seg ? seg.properties.street_name || "" : "", a.condition != null ? String(a.condition) : "", (a.surface || []).join("; "), (a.issues || []).join("; "), a.priority_fix ? "true" : "false", (a.notes || "").replace(/"/g, '""'), a.assessed_at || "", a.source || ""];
      lines.push(csv.map(function (v) { return '"' + v + '"'; }).join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rhinebeck-sidewalk-assessments.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.querySelectorAll("#viewToggle button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.getAttribute("data-view") === "unassessed") {
        showUnassessed = !showUnassessed;
        btn.classList.toggle("active", showUnassessed);
        renderLayer();
      } else {
        setLayer("sidewalks", !showSidewalks);
      }
    });
  });

  // Boot: fetch parcels, then segments, then segment assessments
  // (Supabase first, local as fallback for assessments).
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
      loadingEl.textContent = "Loaded " + parcels.length + " parcels. Loading sidewalk segments…";
      return fetchAll("/rest/v1/sidewalk_segments?select=id,parcelgrid,street_name,geom&order=id")
        .then(function (srows) {
          segmentsLoaded = true;
          segments = srows.map(function (r) {
            return {
              type: "Feature",
              properties: { id: r.id, parcelgrid: r.parcelgrid, street_name: r.street_name },
              geometry: r.geom
            };
          });
          segments.forEach(function (s) {
            segmentById[s.properties.id] = s;
            (segmentsByParcel[s.properties.parcelgrid] = segmentsByParcel[s.properties.parcelgrid] || []).push(s);
          });
          loadingEl.textContent = "Loaded " + segments.length + " sidewalk segments. Loading assessments…";
        })
        .catch(function () {
          // Segments table missing (SQL not run yet): parcels still work,
          // but there is nothing to assess. Hide the Sidewalks toggle.
          segmentsLoaded = false;
          showBanner(
            "Sidewalk segments are not set up yet: the <code>sidewalk_segments</code> table was not found. " +
            "Parcels still load, but assessments need the segments table — run <code>sql/segments.sql</code> (see README)."
          );
          var sb = document.querySelector('#viewToggle button[data-view="sidewalks"]');
          if (sb) sb.style.display = "none";
        });
    })
    .then(function () {
      return fetchAll("/rest/v1/segment_assessments?select=segment_id,condition,surface,issues,priority_fix,notes,assessed_at&order=segment_id")
        .then(function (arows) {
          supabaseSaving = true;
          arows.forEach(function (r) {
            segAssessments[r.segment_id] = {
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
            "Supabase saving is not set up yet: the <code>segment_assessments</code> table was not found. " +
            "Assessments will save in this browser only until you run <code>sql/segments.sql</code> (see README)."
          );
        });
    })
    .then(function () {
      // Merge in any assessments saved locally in this browser.
      var local = loadLocalAssessments();
      Object.keys(local).forEach(function (id) {
        if (!segAssessments[id]) segAssessments[id] = local[id];
      });
      loadingEl.style.display = "none";
      renderLayer();
      map.fitBounds(boundsOfFeatures(parcels), { padding: 40 });
    })
    .catch(function (err) {
      loadingEl.textContent = "Could not load parcels from Supabase (" + err.message + "). Check the key in config.js and that the parcels table exists.";
    });
})();
