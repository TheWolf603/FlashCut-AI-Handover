/**
 * FlashCut AI – hostscript.jsx
 * ExtendScript layer: all communication with Premiere Pro DOM lives here.
 */

/* ─────────────────────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────────────────────── */

function jsonStringify(obj) {
    // Lightweight JSON serialiser for ExtendScript (no JSON built-in in ES3)
    if (obj === null || obj === undefined) return "null";
    var t = typeof obj;
    if (t === "number" || t === "boolean") return String(obj);
    if (t === "string") return '"' + obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
    if (obj instanceof Array) {
        var items = [];
        for (var i = 0; i < obj.length; i++) items.push(jsonStringify(obj[i]));
        return "[" + items.join(",") + "]";
    }
    if (t === "object") {
        var pairs = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) pairs.push('"' + k + '":' + jsonStringify(obj[k]));
        }
        return "{" + pairs.join(",") + "}";
    }
    return "null";
}

function ticksToSeconds(ticks) {
    // Premiere Pro ticks: 254016000000 ticks per second (TimeDisplayFormat_Frames uses this)
    return parseInt(ticks, 10) / 254016000000;
}

function secondsToTicks(seconds) {
    // Premiere's razor() and other APIs need ticks as a string
    return String(Math.round(seconds * 254016000000));
}

function safeStr(v) {
    return (v === undefined || v === null) ? "" : String(v);
}

/* ─────────────────────────────────────────────────────────────
   1. GET ALL SEQUENCES IN THE PROJECT
───────────────────────────────────────────────────────────── */

function getSequences() {
    try {
        if (!app.project) return jsonStringify({ error: "No project open." });
        var seqs = app.project.sequences;
        if (!seqs || seqs.numSequences === 0) {
            return jsonStringify({ error: "NO_SEQUENCES" });
        }
        var list = [];
        for (var i = 0; i < seqs.numSequences; i++) {
            var s = seqs[i];
            list.push({
                id: safeStr(s.sequenceID),
                name: safeStr(s.name),
                duration: ticksToSeconds(s.end),
                frameRate: safeStr(s.timebase),
                videoTracks: s.videoTracks.numTracks,
                audioTracks: s.audioTracks.numTracks
            });
        }
        return jsonStringify({ sequences: list });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   2. GET ACTIVE SEQUENCE
───────────────────────────────────────────────────────────── */

function getActiveSequence() {
    try {
        if (!app.project) return jsonStringify({ error: "No project open." });
        var s = app.project.activeSequence;
        if (!s) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });
        return jsonStringify({
            id: safeStr(s.sequenceID),
            name: safeStr(s.name),
            duration: ticksToSeconds(s.end),
            frameRate: safeStr(s.timebase),
            videoTracks: s.videoTracks.numTracks,
            audioTracks: s.audioTracks.numTracks
        });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   3. SET ACTIVE SEQUENCE BY ID
───────────────────────────────────────────────────────────── */

function setActiveSequenceById(seqId) {
    try {
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            if (safeStr(seqs[i].sequenceID) === seqId) {
                app.project.activeSequence = seqs[i];
                return jsonStringify({ success: true, name: safeStr(seqs[i].name) });
            }
        }
        return jsonStringify({ error: "Sequence not found: " + seqId });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   4. GET SEQUENCE AUDIO SOURCE FILES
   Returns the on-disk paths of every audio clip in the sequence
   so the JS side can read them with cep.fs and decode with Web Audio.
   Each clip includes timeline start/end and source inPoint so the
   JS can map detected silence back to sequence time.
───────────────────────────────────────────────────────────── */

function getSequenceAudioClips() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        var clips = [];
        var seenPaths = {};

        // Helper to extract clip data
        function extractClip(clip, trackIndex) {
            try {
                var mediaPath = clip.projectItem.getMediaPath();
                if (!mediaPath) return;
                mediaPath = mediaPath.replace(/\\/g, "/");

                // Avoid duplicate paths from linked audio/video tracks
                var tlStart = ticksToSeconds(clip.start.ticks);
                var key = mediaPath + "_" + tlStart;
                if (seenPaths[key]) return;
                seenPaths[key] = true;

                var tlEnd   = ticksToSeconds(clip.end.ticks);
                var srcIn   = ticksToSeconds(clip.inPoint.ticks);
                var clipDur = tlEnd - tlStart;
                var srcOut  = srcIn + clipDur;

                clips.push({
                    path:         mediaPath,
                    trackIndex:   trackIndex,
                    timelineStart: tlStart,
                    timelineEnd:   tlEnd,
                    srcInPoint:   srcIn,
                    srcOutPoint:  srcOut,
                    name:         safeStr(clip.name)
                });
            } catch(e) {}
        }

        // Scan dedicated audio tracks first
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var aTrack = seq.audioTracks[at];
            for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
                extractClip(aTrack.clips[ac], at);
            }
        }

        // Also scan video tracks — most sequences use embedded audio in video clips
        // (MP4, MOV, MXF all carry audio inside the video file)
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var vTrack = seq.videoTracks[vt];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                extractClip(vTrack.clips[vc], vt + 1000); // offset to avoid track index collision
            }
        }

        if (clips.length === 0) return jsonStringify({ error: "NO_AUDIO_CLIPS_FOUND" });

        // Sort by timeline start position
        clips.sort(function(a, b) { return a.timelineStart - b.timelineStart; });

        return jsonStringify({
            clips: clips,
            sequenceDuration: ticksToSeconds(seq.end)
        });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   5. STORE GLOBAL DATA (silence regions / captions) from JS side
   Avoids all JSON-escaping issues when passing large payloads
   into ExtendScript via evalScript().
───────────────────────────────────────────────────────────── */

function storeFlashcutData(key, jsonStr) {
    try {
        if (!$.flashcutStore) $.flashcutStore = {};
        // Unescape \\n and \\' that were added by the JS caller before parsing
        var clean = jsonStr.replace(/\\'/g, "'").replace(/\\n/g, "\n");
        $.flashcutStore[key] = eval("(" + clean + ")");
        return jsonStringify({ ok: true });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

function getFlashcutData(key) {
    try {
        if (!$.flashcutStore || !$.flashcutStore[key]) return jsonStringify({ error: "NOT_FOUND" });
        return jsonStringify($.flashcutStore[key]);
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   6. REMOVE SILENCE – apply cuts and ripple delete silent regions
   silentRegions: JSON array of {start, end} in seconds
───────────────────────────────────────────────────────────── */

function removeSilentRegions() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        var regions = ($.flashcutStore && $.flashcutStore["silenceRegions"])
                      ? $.flashcutStore["silenceRegions"] : null;
        if (!regions || !regions.length) {
            return jsonStringify({ error: "NO_REGIONS_IN_STORE" });
        }

        // Get frame rate from sequence timebase (ticks per frame)
        var fps = 25; // fallback
        try {
            // seq.timebase is ticks-per-frame as a string
            var ticksPerFrame = parseFloat(seq.timebase);
            if (ticksPerFrame > 0) {
                fps = Math.round(254016000000 / ticksPerFrame);
            }
        } catch(e) {}

        // Enable QE DOM — required for razor operations
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return jsonStringify({ error: "QE_SEQ_NOT_FOUND" });

        // Sort REVERSE — cut from the end so ripple deletes don't shift earlier positions
        regions.sort(function(a, b) { return b.start - a.start; });

        var removedCount = 0;
        var TICKS = 254016000000;
        var TOL   = Math.round(0.04 * TICKS); // 40ms tolerance in ticks

        for (var r = 0; r < regions.length; r++) {
            var startSec = parseFloat(regions[r].start);
            var endSec   = parseFloat(regions[r].end);
            if (isNaN(startSec) || isNaN(endSec) || endSec - startSec < 0.05) continue;

            // Convert seconds to "HH:MM:SS:FF" timecode string for QE DOM
            var startTC = secondsToTimecode(startSec, fps);
            var endTC   = secondsToTimecode(endSec,   fps);

            // ── Razor cut at both boundaries via QE DOM ──────────────────
            try { qeSeq.razor(startTC); } catch(e) {}
            try { qeSeq.razor(endTC);   } catch(e) {}

            // ── Ripple-delete clips that now sit inside the silence window ─
            var startTicksInt = Math.round(startSec * TICKS);
            var endTicksInt   = Math.round(endSec   * TICKS);

            var trackGroups = [seq.audioTracks, seq.videoTracks];
            for (var tg = 0; tg < trackGroups.length; tg++) {
                var tracks = trackGroups[tg];
                for (var t = 0; t < tracks.numTracks; t++) {
                    var track = tracks[t];
                    for (var c = track.clips.numItems - 1; c >= 0; c--) {
                        try {
                            var clip = track.clips[c];
                            var cS = parseInt(clip.start.ticks, 10);
                            var cE = parseInt(clip.end.ticks,   10);
                            if (cS >= startTicksInt - TOL && cE <= endTicksInt + TOL) {
                                clip.remove(true, false);
                                removedCount++;
                            }
                        } catch(ce) {}
                    }
                }
            }
        }

        return jsonStringify({ success: true, removed: removedCount });

    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

function secondsToTimecode(seconds, fps) {
    var h  = Math.floor(seconds / 3600);
    var m  = Math.floor((seconds % 3600) / 60);
    var s  = Math.floor(seconds % 60);
    var fr = Math.round((seconds - Math.floor(seconds)) * fps);
    if (fr >= fps) { fr = fps - 1; }
    var p = function(n) { return n < 10 ? "0" + n : String(n); };
    return p(h) + ":" + p(m) + ":" + p(s) + ":" + p(fr);
}

/* ─────────────────────────────────────────────────────────────
   7. CREATE CAPTION CLIPS FROM TRANSCRIPTION DATA
   captionsJSON: [{start, end, text}, ...]  (times in seconds)
───────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────
   SHARED HELPER: nuke all existing caption content from sequence
   Called by BOTH createCaptionTrack and applyCaptionStyles
   so they never stack on top of each other.
───────────────────────────────────────────────────────────── */
function nukeExistingCaptions(seq) {
    // 1. Caption tracks API (Premiere 22+)
    try {
        var ct = seq.captionTracks;
        if (ct && ct.numTracks > 0) {
            for (var i = ct.numTracks - 1; i >= 0; i--) {
                try { ct[i].remove(); } catch(e) {}
            }
        }
    } catch(e) {}

    // 2. QE DOM caption tracks
    try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq) {
            for (var q = 0; q < 20; q++) {
                try { qeSeq.deleteCaptionTrack(0); } catch(e) { break; }
            }
        }
    } catch(e) {}

    // 3. Video tracks — SRT imported as video clip in older Premiere
    try {
        for (var vt = seq.videoTracks.numTracks - 1; vt >= 0; vt--) {
            var track = seq.videoTracks[vt];
            for (var vc = track.clips.numItems - 1; vc >= 0; vc--) {
                try {
                    var clip = track.clips[vc];
                    var mp = "";
                    try { mp = safeStr(clip.projectItem.getMediaPath()); } catch(e) {}
                    if (mp.indexOf("FlashCutAI_") !== -1 ||
                        safeStr(clip.name).indexOf("FlashCutAI_") !== -1) {
                        clip.remove(false, false);
                    }
                } catch(e) {}
            }
        }
    } catch(e) {}

    // 4. Project bin cleanup
    removeItemFromBin(app.project.rootItem, "FlashCutAI_");
    $.sleep(300);
}

/* ─────────────────────────────────────────────────────────────
   SHARED HELPER: place a subtitle file on the sequence
   Tries every available Premiere API in order.
───────────────────────────────────────────────────────────── */
function placeSubtitleFile(seq, filePath, format) {
    // format: "srt" | "vtt" | "ass"

    // A: importCaptions (Premiere 22+) — replaces existing content
    var fmtCode = (format === "vtt") ? 2 : 1; // 1=SRT, 2=VTT
    try {
        seq.importCaptions(filePath, fmtCode);
        return { success: true, method: "importCaptions_" + format };
    } catch(eA) {}

    // B: QE DOM addCaptionTrack
    try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq) {
            var qeFmt = (format === "vtt") ? "WebVTT" : "SRT";
            qeSeq.addCaptionTrack(filePath, 0, qeFmt);
            return { success: true, method: "qe_" + format };
        }
    } catch(eB) {}

    // C: Import to bin, then insertClip
    try {
        app.project.importFiles([filePath], true, app.project.rootItem, false);
        var fname = filePath.split("/").pop().replace(/\.(srt|vtt|ass)$/i, "");
        var item = findItemInBin(app.project.rootItem, fname);
        if (item) {
            var tZero = new Time(); tZero.seconds = 0;
            try { seq.insertClip(item, tZero, 0, 0); return { success: true, method: "insertClip" }; } catch(e) {}
            try { seq.appendClip(item, 0);            return { success: true, method: "appendClip" }; } catch(e) {}
        }
    } catch(eC) {}

    return { success: false };
}

/* ─────────────────────────────────────────────────────────────
   7. CREATE CAPTION TRACK (used after transcription)
───────────────────────────────────────────────────────────── */
function createCaptionTrack() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        var captions = ($.flashcutStore && $.flashcutStore["captions"]) ? $.flashcutStore["captions"] : null;
        if (!captions || !captions.length) return jsonStringify({ error: "No captions provided." });

        // Nuke everything first
        nukeExistingCaptions(seq);

        // Write SRT
        var srtFilename = "FlashCutAI_" + (new Date().getTime()) + ".srt";
        var srtPath = Folder.temp.fsName + "/" + srtFilename;
        var srtFile = new File(srtPath);
        srtFile.open("w"); srtFile.encoding = "UTF-8";
        srtFile.write(generateSRT(captions)); srtFile.close();

        var placed = placeSubtitleFile(seq, srtPath, "srt");
        if (placed.success) {
            return jsonStringify({ success: true, count: captions.length, method: placed.method });
        }

        // Last resort: createCaptionTrack native API
        try {
            var captionTrack = seq.createCaptionTrack("FlashCut_Captions", "subtitles");
            var ok = 0;
            for (var i = 0; i < captions.length; i++) {
                try {
                    captionTrack.insertNewSegment(secondsToTicks(captions[i].start), secondsToTicks(captions[i].end), captions[i].text, i);
                    ok++;
                } catch(e) {}
            }
            if (ok > 0) return jsonStringify({ success: true, count: ok, method: "nativeAPI" });
        } catch(e) {}

        return jsonStringify({ error: "Could not place captions on timeline. Check Premiere version." });

    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

// Recursively remove all items named like `nameFragment` from a bin folder
function removeItemFromBin(folder, nameFragment) {
    try {
        for (var i = folder.children.numItems - 1; i >= 0; i--) {
            try {
                var item = folder.children[i];
                if (item.type === ProjectItemType.BIN) {
                    removeItemFromBin(item, nameFragment);
                } else if (safeStr(item.name).indexOf(nameFragment) !== -1) {
                    item.remove();
                }
            } catch(e) {}
        }
    } catch(e) {}
}

// Find first item matching nameFragment anywhere in the project
function findItemInBin(folder, nameFragment) {
    try {
        for (var i = 0; i < folder.children.numItems; i++) {
            try {
                var item = folder.children[i];
                if (item.type === ProjectItemType.BIN) {
                    var found = findItemInBin(item, nameFragment);
                    if (found) return found;
                } else if (safeStr(item.name).indexOf(nameFragment) !== -1) {
                    return item;
                }
            } catch(e) {}
        }
    } catch(e) {}
    return null;
}
/* ─────────────────────────────────────────────────────────────
   9. APPLY CAPTION STYLES (used by Style My Captions panel)
   Nukes old captions, writes a VTT with position cues and an
   ASS file for full font/color/animation support, places the
   best available format on the timeline.
───────────────────────────────────────────────────────────── */
function applyCaptionStyles() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        var style    = ($.flashcutStore && $.flashcutStore["captionStyle"]) ? $.flashcutStore["captionStyle"] : {};
        var captions = ($.flashcutStore && $.flashcutStore["captions"])     ? $.flashcutStore["captions"]     : null;
        if (!captions || !captions.length) return jsonStringify({ error: "No captions. Generate captions first." });

        // Nuke ALL existing captions before placing styled ones
        nukeExistingCaptions(seq);

        var ts = new Date().getTime();

        // ── Write ASS (full styling: font, color, size, bg, animations) ──
        var assPath = Folder.temp.fsName + "/FlashCutAI_" + ts + ".ass";
        var assFile = new File(assPath);
        assFile.open("w"); assFile.encoding = "UTF-8";
        assFile.write(generateASS(captions, style)); assFile.close();

        // ── Write VTT (position cues, widely supported) ───────────────────
        var vttPath = Folder.temp.fsName + "/FlashCutAI_" + (ts+1) + ".vtt";
        var vttFile = new File(vttPath);
        vttFile.open("w"); vttFile.encoding = "UTF-8";
        vttFile.write(generateStyledVTT(captions, style)); vttFile.close();

        // ── Write SRT (plain fallback) ────────────────────────────────────
        var srtPath = Folder.temp.fsName + "/FlashCutAI_" + (ts+2) + ".srt";
        var srtFile = new File(srtPath);
        srtFile.open("w"); srtFile.encoding = "UTF-8";
        srtFile.write(generateSRT(captions)); srtFile.close();

        // ── Try to import ASS via project importFiles (not importCaptions) ─
        // Premiere imports ASS as a subtitle item and renders full styling
        try {
            app.project.importFiles([assPath], true, app.project.rootItem, false);
            var assName = "FlashCutAI_" + ts;
            var assItem = findItemInBin(app.project.rootItem, assName);
            if (assItem) {
                var tZero = new Time(); tZero.seconds = 0;
                seq.insertClip(assItem, tZero, seq.videoTracks.numTracks - 1, 0);
                return jsonStringify({ success: true, method: "ass_insertClip", count: captions.length });
            }
        } catch(eAss) {}

        // ── Try VTT via importCaptions ─────────────────────────────────────
        var vttPlaced = placeSubtitleFile(seq, vttPath, "vtt");
        if (vttPlaced.success) {
            return jsonStringify({ success: true, method: vttPlaced.method, count: captions.length });
        }

        // ── Try SRT via importCaptions ─────────────────────────────────────
        var srtPlaced = placeSubtitleFile(seq, srtPath, "srt");
        if (srtPlaced.success) {
            return jsonStringify({ success: true, method: srtPlaced.method, count: captions.length });
        }

        return jsonStringify({ error: "Could not place styled captions. All strategies failed." });

    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

function generateSRT(captions) {
    var srt = "";
    for (var i = 0; i < captions.length; i++) {
        var cap = captions[i];
        srt += (i + 1) + "\r\n";
        srt += formatSRTTime(cap.start) + " --> " + formatSRTTime(cap.end) + "\r\n";
        srt += (cap.text || "") + "\r\n\r\n";
    }
    return srt;
}

function formatSRTTime(seconds) {
    var h  = Math.floor(seconds / 3600);
    var m  = Math.floor((seconds % 3600) / 60);
    var s  = Math.floor(seconds % 60);
    var ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + "," + pad3(ms);
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function pad3(n) { return n < 10 ? "00" + n : (n < 100 ? "0" + n : String(n)); }

function generateStyledVTT(captions, style) {
    var posMap = {
        "top-left":   "line:10% position:15% align:left",
        "top-center": "line:10% position:50% align:center",
        "top-right":  "line:10% position:85% align:right",
        "mid-left":   "line:50% position:15% align:left",
        "mid-center": "line:50% position:50% align:center",
        "mid-right":  "line:50% position:85% align:right",
        "bot-left":   "line:88% position:15% align:left",
        "bot-center": "line:88% position:50% align:center",
        "bot-right":  "line:88% position:85% align:right"
    };
    var pos = posMap[style.position || "bot-center"] || posMap["bot-center"];
    var vtt = "WEBVTT\n\n";
    vtt += "STYLE\n::cue {\n";
    if (style.fontFamily) vtt += "  font-family: " + style.fontFamily + ";\n";
    if (style.fontSize)   vtt += "  font-size: " + style.fontSize + "px;\n";
    if (style.textColor)  vtt += "  color: " + style.textColor + ";\n";
    if (style.fontWeight === "700" || style.fontWeight === "900") vtt += "  font-weight: bold;\n";
    if (style.bgEnabled && style.bgColor) {
        var hex = style.bgColor.replace("#","");
        if (hex.length===3) hex=hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        var r=parseInt(hex.substr(0,2),16),g=parseInt(hex.substr(2,2),16),b=parseInt(hex.substr(4,2),16);
        var a = ((style.bgOpacity||75)/100).toFixed(2);
        vtt += "  background-color: rgba(" + r + "," + g + "," + b + "," + a + ");\n";
    } else { vtt += "  background-color: transparent;\n"; }
    vtt += "}\n\n";
    for (var i = 0; i < captions.length; i++) {
        var cap = captions[i];
        vtt += (i+1) + "\n";
        vtt += formatVTTTime(cap.start) + " --> " + formatVTTTime(cap.end) + " " + pos + "\n";
        vtt += (cap.text||"") + "\n\n";
    }
    return vtt;
}

function generateASS(captions, style) {
    function hexToASS(hex, alphaPercent) {
        hex = hex.replace("#","");
        if (hex.length===3) hex=hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        var r=hex.substr(0,2), g=hex.substr(2,2), b=hex.substr(4,2);
        var a=Math.round(((100-(alphaPercent||100))/100)*255).toString(16).toUpperCase();
        if (a.length===1) a="0"+a;
        return "&H"+a+b+g+r;
    }
    var fontName  = style.fontFamily || "Arial";
    var fontSize  = style.fontSize   || 40;
    var bold      = (style.fontWeight==="700"||style.fontWeight==="900") ? -1 : 0;
    var textCol   = hexToASS(style.textColor||"#FFFFFF",100);
    var outCol    = hexToASS("#000000",100);
    var bgCol     = style.bgEnabled ? hexToASS(style.bgColor||"#000000",style.bgOpacity||75) : "&H00000000";
    var outline   = style.outline ? 2 : (style.shadow ? 1 : 0);
    var shadow    = style.shadow  ? 2 : 0;
    var alignMap  = {"bot-left":1,"bot-center":2,"bot-right":3,"mid-left":4,"mid-center":5,"mid-right":6,"top-left":7,"top-center":8,"top-right":9};
    var alignment = alignMap[style.position||"bot-center"]||2;
    var marginV   = 40;
    var anim      = style.animation||"none";
    var speed     = style.animSpeed||5;
    var fadeDur   = Math.round(800-(speed-1)*75);

    var ass="";
    ass+="[Script Info]\r\nScriptType: v4.00+\r\nPlayResX: 1920\r\nPlayResY: 1080\r\nScaledBorderAndShadow: yes\r\n\r\n";
    ass+="[V4+ Styles]\r\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\n";
    ass+="Style: Default,"+fontName+","+fontSize+","+textCol+",&H000000FF,"+outCol+","+bgCol+","+bold+",0,0,0,100,100,0,0,1,"+outline+","+shadow+","+alignment+",10,10,"+marginV+",1\r\n\r\n";
    ass+="[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n";

    for (var i=0;i<captions.length;i++) {
        var cap=captions[i];
        var s=assTime(cap.start), e=assTime(cap.end);
        var tag="";
        if (anim==="fade")       tag="{\\fad("+fadeDur+","+fadeDur+")}";
        else if(anim==="slide-up") tag="{\\move(960,"+(1080-marginV+30)+",960,"+(1080-marginV)+",0,"+fadeDur+")\\fad("+fadeDur+",0)}";
        else if(anim==="slide-down") tag="{\\move(960,"+(marginV-30)+",960,"+marginV+",0,"+fadeDur+")\\fad("+fadeDur+",0)}";
        else if(anim==="pop"||anim==="zoom") tag="{\\fad("+fadeDur+",0)\\t(0,"+fadeDur+",\\fscx100\\fscy100)\\fscx20\\fscy20}";
        else if(anim==="bounce") tag="{\\fad("+Math.round(fadeDur*0.3)+",0)\\t(0,"+fadeDur+",\\fscx100\\fscy100)\\fscx80\\fscy80}";
        else if(anim==="blur-in") tag="{\\fad("+fadeDur+",0)\\t(0,"+fadeDur+",\\blur0)\\blur8}";
        else if(anim==="flicker") tag="{\\t(0,"+Math.round(fadeDur*0.1)+",\\alpha&HFF&)\\t("+Math.round(fadeDur*0.1)+","+Math.round(fadeDur*0.2)+",\\alpha&H00&)\\t("+Math.round(fadeDur*0.2)+","+Math.round(fadeDur*0.3)+",\\alpha&HFF&)\\t("+Math.round(fadeDur*0.3)+","+fadeDur+",\\alpha&H00&)}";
        else if(anim==="typewriter") {
            var txt=cap.text||"";
            var cd=(cap.end-cap.start)/Math.max(txt.length,1);
            for(var ci=1;ci<=txt.length;ci++) {
                ass+="Dialogue: 0,"+assTime(cap.start+(ci-1)*cd)+","+assTime(cap.start+ci*cd)+",Default,,0,0,0,,"+txt.substring(0,ci)+"\r\n";
            }
            continue;
        }
        else if(anim==="karaoke") {
            var kw=(cap.text||"").split(" ");
            var kd=Math.round((cap.end-cap.start)*1000/Math.max(kw.length,1));
            var kt="";
            for(var ki=0;ki<kw.length;ki++){kt+="{\\k"+kd+"}"+kw[ki]+(ki<kw.length-1?" ":"");}
            ass+="Dialogue: 0,"+s+","+e+",Default,,0,0,0,karaoke,"+kt+"\r\n";
            continue;
        }
        ass+="Dialogue: 0,"+s+","+e+",Default,,0,0,0,,"+tag+(cap.text||"").replace(/\n/g,"\\N")+"\r\n";
    }
    return ass;
}

function assTime(seconds) {
    var h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60), s=Math.floor(seconds%60);
    var cs=Math.round((seconds-Math.floor(seconds))*100);
    var p=function(n,w){var x=String(n);while(x.length<w)x="0"+x;return x;};
    return h+":"+p(m,2)+":"+p(s,2)+"."+p(cs,2);
}

function formatVTTTime(seconds) {
    var h  = Math.floor(seconds / 3600);
    var m  = Math.floor((seconds % 3600) / 60);
    var s  = Math.floor(seconds % 60);
    var ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + "." + pad3(ms);
}

/* ─────────────────────────────────────────────────────────────
   10. GET TEMP FOLDER PATH (for audio export)
───────────────────────────────────────────────────────────── */

function getTempPath() {
    try {
        var tempPath = Folder.temp.fsName;
        return jsonStringify({ path: tempPath });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   11. GET PROJECT PATH (for relative exports)
───────────────────────────────────────────────────────────── */

function getProjectPath() {
    try {
        if (!app.project) return jsonStringify({ error: "No project." });
        return jsonStringify({ path: safeStr(app.project.path) });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   12. EXPORT AUDIO VIA SCRIPT (alternate method)
───────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────
   13. OPEN SRT FILE IN FINDER/EXPLORER
───────────────────────────────────────────────────────────── */

function revealFileInOS(filePath) {
    try {
        var f = new File(filePath);
        f.execute();
        return jsonStringify({ success: true });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   14. GET SEQUENCE DETAILS (for preview / metadata display)
───────────────────────────────────────────────────────────── */

function getSequenceDetails(seqId) {
    try {
        var seqs = app.project.sequences;
        var seq = null;
        if (seqId) {
            for (var i = 0; i < seqs.numSequences; i++) {
                if (safeStr(seqs[i].sequenceID) === seqId) { seq = seqs[i]; break; }
            }
        } else {
            seq = app.project.activeSequence;
        }
        if (!seq) return jsonStringify({ error: "Sequence not found." });

        var audioClipCount = 0;
        var aTracks = seq.audioTracks;
        for (var t = 0; t < aTracks.numTracks; t++) {
            audioClipCount += aTracks[t].clips.numItems;
        }

        return jsonStringify({
            id: safeStr(seq.sequenceID),
            name: safeStr(seq.name),
            duration: ticksToSeconds(seq.end),
            frameRate: safeStr(seq.timebase),
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: seq.audioTracks.numTracks,
            audioClipCount: audioClipCount
        });
    } catch (e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   INIT – report ready
───────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────
   ADD CHAPTER MARKERS TO SEQUENCE
   Reads chapters from $.flashcutStore["chapters"] and creates
   named sequence markers at each chapter start time.
───────────────────────────────────────────────────────────── */

function addChapterMarkers() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        var chapters = ($.flashcutStore && $.flashcutStore["chapters"]) ? $.flashcutStore["chapters"] : null;
        if (!chapters || !chapters.length) return jsonStringify({ success: true, count: 0 });

        var added = 0;

        for (var i = 0; i < chapters.length; i++) {
            var ch = chapters[i];
            try {
                var marker = seq.markers.createMarker(ch.start);
                marker.name    = ch.headline || ('Chapter ' + (i + 1));
                marker.comments = ch.gist    || '';
                marker.type    = 0; // 0 = chapter marker
                added++;
            } catch(me) {
                // Try comment marker as fallback
                try {
                    var m2 = seq.markers.createMarker(ch.start);
                    m2.name = ch.headline || ('Chapter ' + (i + 1));
                    added++;
                } catch(me2) {}
            }
        }

        return jsonStringify({ success: true, count: added });
    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   GET ALL SEQUENCES (for batch processing)
   Returns id, name, duration for every sequence in the project
───────────────────────────────────────────────────────────── */

function getAllSequenceIds() {
    try {
        var seqs = app.project.sequences;
        if (!seqs || seqs.numSequences === 0) return jsonStringify({ sequences: [] });
        var list = [];
        for (var i = 0; i < seqs.numSequences; i++) {
            var s = seqs[i];
            list.push({
                id:       safeStr(s.sequenceID),
                name:     safeStr(s.name),
                duration: ticksToSeconds(s.end)
            });
        }
        return jsonStringify({ sequences: list });
    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

function init() {
    return jsonStringify({ ready: true, version: "1.0.0" });
}

/* ─────────────────────────────────────────────────────────────
   READ CAPTION SEGMENTS FROM ACTIVE CAPTION TRACK
   Returns all caption segments currently on the timeline so the
   plugin can stay in sync with edits made in Essential Graphics.
───────────────────────────────────────────────────────────── */

function getCaptionSegments() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        var segments = [];

        // Try caption tracks API (Premiere 22+)
        try {
            var capTracks = seq.captionTracks;
            if (capTracks && capTracks.numTracks > 0) {
                var track = capTracks[0]; // use first caption track
                for (var i = 0; i < track.clips.numItems; i++) {
                    try {
                        var seg = track.clips[i];
                        segments.push({
                            index: i,
                            start: ticksToSeconds(seg.start.ticks),
                            end:   ticksToSeconds(seg.end.ticks),
                            text:  safeStr(seg.getText ? seg.getText() : seg.text)
                        });
                    } catch(e) {}
                }
                if (segments.length > 0) {
                    return jsonStringify({ segments: segments, source: "captionTracks" });
                }
            }
        } catch(e) {}

        return jsonStringify({ segments: [], source: "none" });
    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}

/* ─────────────────────────────────────────────────────────────
   UPDATE A SINGLE CAPTION SEGMENT TEXT IN PREMIERE
   Called when user edits a caption in the plugin — surgically
   updates just that one segment without re-importing everything.
───────────────────────────────────────────────────────────── */

function updateCaptionSegment(index, newText) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return jsonStringify({ error: "NO_ACTIVE_SEQUENCE" });

        // Try caption tracks API
        try {
            var capTracks = seq.captionTracks;
            if (capTracks && capTracks.numTracks > 0) {
                var track = capTracks[0];
                var seg = track.clips[index];
                if (!seg) return jsonStringify({ error: "Segment " + index + " not found" });

                // Try different text-setting APIs
                try { seg.setText(newText); return jsonStringify({ success: true, method: "setText" }); } catch(e) {}
                try { seg.text = newText;   return jsonStringify({ success: true, method: "text_prop" }); } catch(e) {}
                try { seg.name = newText;   return jsonStringify({ success: true, method: "name_prop" }); } catch(e) {}
            }
        } catch(e) {}

        return jsonStringify({ error: "Could not update segment — caption track API not available" });
    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}
