// ============================================================
// FlashCut AI - ExtendScript Host Functions
// Communicates directly with Adobe Premiere Pro 2023 API
// ============================================================

#include "json2.js"

// --------------- UTILITY FUNCTIONS ---------------

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function pad3(n) { if (n < 10) return "00" + n; if (n < 100) return "0" + n; return String(n); }

function formatSRTTime(seconds) {
    var totalMs = Math.round(seconds * 1000);
    var ms = totalMs % 1000;
    var s  = Math.floor(totalMs / 1000) % 60;
    var m  = Math.floor(totalMs / 60000) % 60;
    var h  = Math.floor(totalMs / 3600000);
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + "," + pad3(ms);
}

function getSequenceById(sequenceId) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        if (app.project.sequences[i].sequenceID === sequenceId) {
            return app.project.sequences[i];
        }
    }
    return null;
}

// --------------- SEQUENCE MANAGEMENT ---------------

function flashcut_getSequences() {
    try {
        if (!app.project) {
            return JSON.stringify({ success: false, error: "No project is currently open in Premiere Pro." });
        }

        var numSeq = app.project.sequences.numSequences;
        if (numSeq === 0) {
            return JSON.stringify({
                success: false,
                error: "No sequence found. Please create a sequence in your project first (File → New → Sequence)."
            });
        }

        var sequences = [];
        var activeId = "";

        try {
            if (app.project.activeSequence) {
                activeId = app.project.activeSequence.sequenceID;
            }
        } catch (e) {}

        for (var i = 0; i < numSeq; i++) {
            var seq = app.project.sequences[i];
            var dur = 0;
            var fps = 0;
            var w = 0;
            var h = 0;
            var vTracks = 0;
            var aTracks = 0;

            try { dur = parseFloat(seq.end.seconds); } catch(e) {}
            try { fps = seq.timebase ? parseFloat(1 / parseFloat(seq.timebase)) : 0; } catch(e) {}
            try { w = seq.frameSizeHorizontal; } catch(e) {}
            try { h = seq.frameSizeVertical; } catch(e) {}
            try { vTracks = seq.videoTracks.numTracks; } catch(e) {}
            try { aTracks = seq.audioTracks.numTracks; } catch(e) {}

            sequences.push({
                id:          seq.sequenceID,
                name:        seq.name,
                duration:    dur,
                frameRate:   fps,
                width:       w,
                height:      h,
                videoTracks: vTracks,
                audioTracks: aTracks,
                isActive:    (seq.sequenceID === activeId)
            });
        }

        return JSON.stringify({
            success:    true,
            sequences:  sequences,
            activeId:   activeId,
            projectName: app.project.name
        });

    } catch (e) {
        return JSON.stringify({ success: false, error: "Error reading project: " + e.toString() });
    }
}

function flashcut_setActiveSequence(sequenceId) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, error: "Sequence not found." });
        }
        app.project.activeSequence = seq;
        var dur = 0;
        try { dur = parseFloat(seq.end.seconds); } catch(e) {}
        return JSON.stringify({ success: true, name: seq.name, duration: dur });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// --------------- AUDIO / MEDIA PATH RETRIEVAL ---------------

function flashcut_getSourceMediaPaths(sequenceId) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, error: "Sequence not found." });
        }

        var paths = [];
        var seenPaths = {};

        var numATracks = seq.audioTracks.numTracks;
        for (var t = 0; t < numATracks; t++) {
            var track = seq.audioTracks[t];
            var numClips = track.clips.numItems;
            for (var c = 0; c < numClips; c++) {
                var clip = track.clips[c];
                try {
                    var mediaPath = clip.projectItem.getMediaPath();
                    if (mediaPath && !seenPaths[mediaPath]) {
                        seenPaths[mediaPath] = true;
                        var ext = mediaPath.split(".").pop().toLowerCase();
                        paths.push({
                            path: mediaPath,
                            name: clip.name,
                            type: (["mp3","wav","aac","flac","ogg","m4a","aiff","wma"].indexOf(ext) !== -1) ? "audio" : "video",
                            ext:  ext
                        });
                    }
                } catch (e2) {}
            }
        }

        // Also check video tracks for audio-containing clips
        var numVTracks = seq.videoTracks.numTracks;
        for (var vt = 0; vt < numVTracks; vt++) {
            var vtrack = seq.videoTracks[vt];
            var nvClips = vtrack.clips.numItems;
            for (var vc = 0; vc < nvClips; vc++) {
                var vclip = vtrack.clips[vc];
                try {
                    var vMediaPath = vclip.projectItem.getMediaPath();
                    if (vMediaPath && !seenPaths[vMediaPath]) {
                        seenPaths[vMediaPath] = true;
                        var vext = vMediaPath.split(".").pop().toLowerCase();
                        paths.push({
                            path: vMediaPath,
                            name: vclip.name,
                            type: "video",
                            ext:  vext
                        });
                    }
                } catch (e3) {}
            }
        }

        return JSON.stringify({ success: true, paths: paths, count: paths.length });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function flashcut_getTempDir() {
    try {
        var tempPath = Folder.temp.absoluteURI;
        var isWin = ($.os.indexOf("Windows") !== -1);
        var sep = isWin ? "\\" : "/";
        // Convert URI to OS path
        if (isWin && tempPath.charAt(0) === "/") {
            tempPath = tempPath.substring(1).replace(/\//g, "\\");
        }
        return JSON.stringify({ success: true, path: tempPath, separator: sep, isWindows: isWin });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// --------------- SILENCE / GAP DETECTION ---------------

function flashcut_analyzeAudioGaps(sequenceId, minGapSeconds) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, error: "Sequence not found." });
        }

        var minGap = parseFloat(minGapSeconds) || 0.3;
        var seqDuration = 0;
        try { seqDuration = parseFloat(seq.end.seconds); } catch(e) {}

        // Collect ALL clip ranges across ALL audio tracks
        var allRanges = [];
        var numATracks = seq.audioTracks.numTracks;

        for (var t = 0; t < numATracks; t++) {
            var track = seq.audioTracks[t];
            if (!track || !track.clips) continue;
            var numClips = track.clips.numItems;
            for (var c = 0; c < numClips; c++) {
                var clip = track.clips[c];
                try {
                    var s = parseFloat(clip.start.seconds);
                    var e2 = parseFloat(clip.end.seconds);
                    if (e2 > s) allRanges.push({ start: s, end: e2 });
                } catch(e3) {}
            }
        }

        if (allRanges.length === 0) {
            return JSON.stringify({ success: false, error: "No audio clips found in this sequence." });
        }

        // Sort and merge overlapping ranges to create a unified "covered" timeline
        allRanges.sort(function(a, b) { return a.start - b.start; });
        var merged = [allRanges[0]];
        for (var i = 1; i < allRanges.length; i++) {
            var last = merged[merged.length - 1];
            if (allRanges[i].start <= last.end) {
                if (allRanges[i].end > last.end) last.end = allRanges[i].end;
            } else {
                merged.push({ start: allRanges[i].start, end: allRanges[i].end });
            }
        }

        // Find gaps between merged ranges
        var gaps = [];
        for (var j = 0; j < merged.length - 1; j++) {
            var gapStart = merged[j].end;
            var gapEnd   = merged[j + 1].start;
            var gapDur   = gapEnd - gapStart;
            if (gapDur >= minGap) {
                gaps.push({
                    start:    Math.round(gapStart * 1000) / 1000,
                    end:      Math.round(gapEnd * 1000) / 1000,
                    duration: Math.round(gapDur * 1000) / 1000
                });
            }
        }

        // Also check gap at very start
        if (merged[0].start >= minGap) {
            gaps.unshift({
                start:    0,
                end:      Math.round(merged[0].start * 1000) / 1000,
                duration: Math.round(merged[0].start * 1000) / 1000
            });
        }

        // Sort by start time (for proper removal order)
        gaps.sort(function(a, b) { return a.start - b.start; });

        var totalSilenceDuration = 0;
        for (var g = 0; g < gaps.length; g++) {
            totalSilenceDuration += gaps[g].duration;
        }

        return JSON.stringify({
            success: true,
            gaps: gaps,
            gapCount: gaps.length,
            totalSilenceDuration: Math.round(totalSilenceDuration * 100) / 100,
            sequenceDuration: Math.round(seqDuration * 100) / 100,
            audioTrackCount: numATracks
        });

    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function flashcut_removeSilenceGaps(sequenceId, gapsJSON) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, error: "Sequence not found." });
        }

        app.project.activeSequence = seq;
        app.enableQE();

        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) {
            return JSON.stringify({ success: false, error: "Could not access QE sequence. Ensure your sequence is active." });
        }

        var gaps = JSON.parse(gapsJSON);
        if (!gaps || gaps.length === 0) {
            return JSON.stringify({ success: false, error: "No gaps provided." });
        }

        // Process in REVERSE order to preserve time positions
        var reversedGaps = gaps.slice().sort(function(a, b) { return b.start - a.start; });

        var removed = 0;
        var errors  = [];

        // Ticks per second in Premiere Pro
        var TICKS_PER_SEC = 254016000000;

        for (var r = 0; r < reversedGaps.length; r++) {
            var gap = reversedGaps[r];
            try {
                var inTicks  = String(Math.round(gap.start * TICKS_PER_SEC));
                var outTicks = String(Math.round(gap.end   * TICKS_PER_SEC));

                qeSeq.setInPoint(inTicks);
                qeSeq.setOutPoint(outTicks);
                qeSeq.extractAndClose();
                removed++;
            } catch (err) {
                errors.push("Gap at " + gap.start + "s: " + err.toString());
            }
        }

        // Clear in/out points
        try {
            seq.setInPoint(-1);
            seq.setOutPoint(-1);
        } catch(e) {}

        return JSON.stringify({
            success: true,
            removed: removed,
            errors:  errors,
            message: "Successfully removed " + removed + " silence gap" + (removed !== 1 ? "s" : "") + " from the timeline."
        });

    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// --------------- CAPTIONS ---------------

function flashcut_importSRTAndApply(sequenceId, srtContent, captionLabel) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, error: "Sequence not found." });
        }

        // Write SRT file to temp folder
        var tempDir  = Folder.temp.absoluteURI;
        var srtPath  = tempDir + "/flashcut_captions_" + new Date().getTime() + ".srt";
        var srtFile  = new File(srtPath);
        srtFile.encoding = "UTF-8";
        srtFile.open("w");
        srtFile.write(srtContent);
        srtFile.close();

        // Convert URI to OS path for import
        var osSrtPath = srtPath;
        var isWin = ($.os.indexOf("Windows") !== -1);
        if (isWin && osSrtPath.charAt(0) === "/") {
            osSrtPath = osSrtPath.substring(1).replace(/\//g, "\\");
        }

        // Import SRT into project
        app.project.activeSequence = seq;
        var importResult = app.project.importFiles([osSrtPath], true, app.project.rootItem, false);

        return JSON.stringify({
            success: true,
            srtPath: osSrtPath,
            message: "SRT captions file written and imported. Look for '" + (captionLabel || "flashcut_captions") + "' in your Project Panel. Drag it onto the caption track in your sequence."
        });

    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function flashcut_generateSRTContent(captionsJSON) {
    try {
        var captions = JSON.parse(captionsJSON);
        var srtLines = [];
        for (var i = 0; i < captions.length; i++) {
            var cap = captions[i];
            srtLines.push((i + 1) + "\n" +
                formatSRTTime(cap.start) + " --> " + formatSRTTime(cap.end) + "\n" +
                cap.text);
        }
        var srtContent = srtLines.join("\n\n") + "\n";
        return JSON.stringify({ success: true, content: srtContent });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// Write SRT to file and return OS path
function flashcut_writeSRTFile(srtContent) {
    try {
        var tempDir = Folder.temp.absoluteURI;
        var srtPath = tempDir + "/flashcut_export_" + new Date().getTime() + ".srt";
        var srtFile = new File(srtPath);
        srtFile.encoding = "UTF-8";
        srtFile.open("w");
        srtFile.write(srtContent);
        srtFile.close();

        var osSrtPath = srtPath;
        var isWin = ($.os.indexOf("Windows") !== -1);
        if (isWin && osSrtPath.charAt(0) === "/") {
            osSrtPath = osSrtPath.substring(1).replace(/\//g, "\\");
        }
        return JSON.stringify({ success: true, path: osSrtPath });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

