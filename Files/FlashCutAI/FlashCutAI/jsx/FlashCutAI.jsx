/**
 * FlashCut AI - ExtendScript (JSX)
 * Core Premiere Pro API integration
 * Compatible with Premiere Pro 2019+ (v13+)
 */

// ============================================================
//  UTILITY HELPERS
// ============================================================

function log(msg) {
    $.writeln("[FlashCutAI] " + msg);
}

function getTicksPerSecond() {
    return 254016000000;
}

function secondsToTicks(seconds) {
    return Math.round(seconds * getTicksPerSecond());
}

function ticksToSeconds(ticks) {
    return ticks / getTicksPerSecond();
}

function zeroPad(n, len) {
    var s = String(n);
    while (s.length < len) s = "0" + s;
    return s;
}

function secondsToSRTTime(totalSeconds) {
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = Math.floor(totalSeconds % 60);
    var ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
    return zeroPad(h, 2) + ":" + zeroPad(m, 2) + ":" + zeroPad(s, 2) + "," + zeroPad(ms, 3);
}

function getTempFolder() {
    var tmpPath = Folder.temp.fsName;
    var flashcutFolder = new Folder(tmpPath + "/FlashCutAI");
    if (!flashcutFolder.exists) {
        flashcutFolder.create();
    }
    return flashcutFolder;
}

function getExtensionPath() {
    try {
        return new File($.fileName).parent.parent.fsName;
    } catch (e) {
        return Folder.temp.fsName;
    }
}

// ============================================================
//  PROJECT & SEQUENCE DISCOVERY
// ============================================================

/**
 * Returns a JSON string describing all sequences in the project.
 * Called by the panel on startup.
 */
function getProjectSequences() {
    try {
        if (!app.project) {
            return JSON.stringify({ error: "NO_PROJECT", message: "No project is open in Premiere Pro." });
        }

        var sequences = app.project.sequences;
        if (!sequences || sequences.numSequences === 0) {
            return JSON.stringify({ error: "NO_SEQUENCE", message: "No sequences found. Please create a sequence in your project first." });
        }

        var result = [];
        for (var i = 0; i < sequences.numSequences; i++) {
            var seq = sequences[i];
            try {
                var framerate = seq.timebase;
                var durationTicks = seq.end;
                var durationSecs = ticksToSeconds(parseFloat(durationTicks));
                result.push({
                    id: seq.sequenceID,
                    name: seq.name,
                    duration: durationSecs,
                    durationFormatted: secondsToSRTTime(durationSecs).split(",")[0],
                    videoTracks: seq.videoTracks.numTracks,
                    audioTracks: seq.audioTracks.numTracks,
                    framerate: framerate,
                    isActive: (app.project.activeSequence && app.project.activeSequence.sequenceID === seq.sequenceID)
                });
            } catch (seqErr) {
                log("Error reading sequence " + i + ": " + seqErr.toString());
                result.push({
                    id: "seq_" + i,
                    name: seq.name || ("Sequence " + (i + 1)),
                    duration: 0,
                    durationFormatted: "00:00:00",
                    videoTracks: 0,
                    audioTracks: 0,
                    framerate: "25",
                    isActive: false
                });
            }
        }

        return JSON.stringify({ sequences: result });
    } catch (e) {
        return JSON.stringify({ error: "ERROR", message: e.toString() });
    }
}

/**
 * Sets the active sequence by its ID.
 */
function setActiveSequenceById(sequenceId) {
    try {
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var seq = app.project.sequences[i];
            if (seq.sequenceID === sequenceId) {
                app.project.activeSequence = seq;
                return JSON.stringify({ success: true, name: seq.name });
            }
        }
        return JSON.stringify({ success: false, message: "Sequence not found." });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Retrieves the sequence object by ID.
 */
function getSequenceById(sequenceId) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var seq = app.project.sequences[i];
        if (seq.sequenceID === sequenceId) return seq;
    }
    return null;
}

// ============================================================
//  AUDIO EXPORT FOR CAPTIONS & SILENCE DETECTION
// ============================================================

/**
 * Exports audio from the selected sequence as WAV to a temp folder.
 * Returns the file path on disk.
 */
function exportSequenceAudio(sequenceId) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, message: "Sequence not found." });
        }

        var tmpFolder = getTempFolder();
        var outputPath = tmpFolder.fsName + "/flashcut_audio_" + sequenceId + ".wav";

        // Check if app.encoder is available (requires AME)
        if (app.encoder) {
            // Try to use Adobe Media Encoder
            try {
                var presetPath = "";
                // Locate a WAV or audio-only preset
                var encoderPresets = app.encoder.getExporters();
                var wavPreset = null;
                for (var p = 0; p < encoderPresets.length; p++) {
                    if (encoderPresets[p].match && encoderPresets[p].match(/WAV|wav/)) {
                        wavPreset = encoderPresets[p];
                        break;
                    }
                }

                app.encoder.encodeSequence(seq, outputPath, presetPath, 1, 1);
                return JSON.stringify({ success: true, path: outputPath, method: "AME" });
            } catch (encErr) {
                log("AME export failed: " + encErr.toString());
            }
        }

        // Fallback: Export using project export method
        try {
            var exportJob = seq.exportAsMasterClip(outputPath, false, false, false);
            return JSON.stringify({ success: true, path: outputPath, method: "MasterClip" });
        } catch (exportErr) {
            log("Master clip export failed: " + exportErr.toString());
        }

        // Second fallback: Return path for manual export instruction
        return JSON.stringify({
            success: false,
            needsManualExport: true,
            suggestedPath: outputPath,
            message: "Please export your sequence audio manually as WAV to: " + outputPath
        });

    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Gets detailed audio clip info from all audio tracks in the sequence.
 * Used for gap analysis (silence between clips).
 */
function getAudioClipInfo(sequenceId) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) {
            return JSON.stringify({ success: false, message: "Sequence not found." });
        }

        var tracks = [];
        var seqDuration = ticksToSeconds(parseFloat(seq.end));

        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            var clips = [];

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var startSec = ticksToSeconds(parseFloat(clip.start));
                    var endSec = ticksToSeconds(parseFloat(clip.end));
                    clips.push({
                        index: c,
                        name: clip.name || "Clip " + (c + 1),
                        start: startSec,
                        end: endSec,
                        duration: endSec - startSec
                    });
                } catch (clipErr) {
                    log("Error reading clip " + c + ": " + clipErr.toString());
                }
            }

            // Sort by start time
            clips.sort(function(a, b) { return a.start - b.start; });

            tracks.push({
                index: t,
                name: track.name || ("Audio " + (t + 1)),
                clips: clips,
                isMuted: track.isMuted()
            });
        }

        return JSON.stringify({
            success: true,
            tracks: tracks,
            sequenceDuration: seqDuration
        });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

// ============================================================
//  SILENCE REMOVAL
// ============================================================

/**
 * Analyzes tracks for gap silences and returns segment info.
 * Gaps are defined as spaces between clips on audio tracks.
 */
function analyzeGapSilences(sequenceId, minGapDuration) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, message: "Sequence not found." });

        var minGap = parseFloat(minGapDuration) || 0.5;
        var seqDuration = ticksToSeconds(parseFloat(seq.end));
        var gaps = [];

        // Collect all occupied time ranges across all audio tracks
        var occupiedRanges = [];

        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            if (track.isMuted && track.isMuted()) continue;

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                try {
                    var startSec = ticksToSeconds(parseFloat(clip.start));
                    var endSec = ticksToSeconds(parseFloat(clip.end));
                    if (endSec > startSec) {
                        occupiedRanges.push({ start: startSec, end: endSec });
                    }
                } catch (clipErr) {}
            }
        }

        // Merge overlapping ranges
        occupiedRanges.sort(function(a, b) { return a.start - b.start; });
        var merged = [];
        for (var r = 0; r < occupiedRanges.length; r++) {
            var cur = occupiedRanges[r];
            if (merged.length === 0) {
                merged.push({ start: cur.start, end: cur.end });
            } else {
                var last = merged[merged.length - 1];
                if (cur.start <= last.end) {
                    if (cur.end > last.end) last.end = cur.end;
                } else {
                    merged.push({ start: cur.start, end: cur.end });
                }
            }
        }

        // Find gaps between merged ranges
        var cursor = 0;
        for (var m = 0; m < merged.length; m++) {
            var range = merged[m];
            if (range.start > cursor + minGap) {
                gaps.push({ start: cursor, end: range.start, duration: range.start - cursor });
            }
            cursor = range.end;
        }
        // Check gap at end of sequence
        if (seqDuration > cursor + minGap) {
            gaps.push({ start: cursor, end: seqDuration, duration: seqDuration - cursor });
        }

        return JSON.stringify({
            success: true,
            gaps: gaps,
            totalGaps: gaps.length,
            totalGapDuration: gaps.reduce(function(sum, g) { return sum + g.duration; }, 0),
            sequenceDuration: seqDuration
        });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Removes specific gap/silence segments from all audio tracks.
 * gapsJson: JSON array of { start, end } objects (sorted descending by start time).
 */
function removeGapSilences(sequenceId, gapsJson) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, message: "Sequence not found." });

        var gaps;
        try {
            gaps = JSON.parse(gapsJson);
        } catch (parseErr) {
            return JSON.stringify({ success: false, message: "Invalid gaps data." });
        }

        // Sort gaps in DESCENDING order to avoid offset issues when deleting
        gaps.sort(function(a, b) { return b.start - a.start; });

        // Enable undo group
        app.project.activeSequence = seq;
        app.beginUndoGroup("FlashCut AI: Remove Silences");

        var removed = 0;
        for (var g = 0; g < gaps.length; g++) {
            var gap = gaps[g];
            var startTicks = secondsToTicks(gap.start);
            var endTicks = secondsToTicks(gap.end);

            try {
                // Use ripple delete on all tracks
                seq.setInPoint(startTicks);
                seq.setOutPoint(endTicks);

                // Ripple delete selected range
                // Method 1: Using extract (ripple delete)
                var result = seq.performExtractToTape(false);
                if (!result) {
                    // Method 2: Manual approach - razor cuts + delete
                    seq.razor(endTicks);
                    seq.razor(startTicks);

                    // Delete clips in the gap region across all tracks
                    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
                        var track = seq.audioTracks[t];
                        for (var c = track.clips.numItems - 1; c >= 0; c--) {
                            var clip = track.clips[c];
                            var clipStart = ticksToSeconds(parseFloat(clip.start));
                            var clipEnd = ticksToSeconds(parseFloat(clip.end));
                            if (clipStart >= gap.start && clipEnd <= gap.end + 0.01) {
                                clip.remove(true, false); // ripple=true
                                removed++;
                            }
                        }
                    }

                    // Also clean video tracks for completeness
                    for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                        var vTrack = seq.videoTracks[vt];
                        for (var vc = vTrack.clips.numItems - 1; vc >= 0; vc--) {
                            var vClip = vTrack.clips[vc];
                            var vStart = ticksToSeconds(parseFloat(vClip.start));
                            var vEnd = ticksToSeconds(parseFloat(vClip.end));
                            if (vStart >= gap.start && vEnd <= gap.end + 0.01) {
                                vClip.remove(true, false);
                            }
                        }
                    }
                } else {
                    removed++;
                }
            } catch (gapErr) {
                log("Error removing gap at " + gap.start + ": " + gapErr.toString());
            }
        }

        app.endUndoGroup();
        seq.setInPoint(-1);
        seq.setOutPoint(-1);

        return JSON.stringify({ success: true, removedCount: removed, message: "Silences removed successfully." });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Performs a ripple delete between two time points in ALL tracks.
 * More direct approach using Premiere's built-in ripple delete.
 */
function rippleDeleteRegion(sequenceId, startSec, endSec) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, message: "Sequence not found." });

        var startTicks = secondsToTicks(parseFloat(startSec));
        var endTicks = secondsToTicks(parseFloat(endSec));

        app.project.activeSequence = seq;
        app.beginUndoGroup("FlashCut AI: Ripple Delete Region");

        // Razor all tracks at start and end points
        seq.razor(startTicks);
        seq.razor(endTicks);

        // Find and remove all clips in the region
        var deleted = 0;

        // Process audio tracks (descending)
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var aTrack = seq.audioTracks[at];
            for (var ac = aTrack.clips.numItems - 1; ac >= 0; ac--) {
                var aClip = aTrack.clips[ac];
                var aStart = parseFloat(aClip.start);
                var aEnd = parseFloat(aClip.end);
                if (aStart >= startTicks - 1000 && aEnd <= endTicks + 1000) {
                    try {
                        aClip.remove(true, false);
                        deleted++;
                    } catch (re) {}
                }
            }
        }

        // Process video tracks (descending)
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var vTrack = seq.videoTracks[vt];
            for (var vc = vTrack.clips.numItems - 1; vc >= 0; vc--) {
                var vClip = vTrack.clips[vc];
                var vStart = parseFloat(vClip.start);
                var vEnd = parseFloat(vClip.end);
                if (vStart >= startTicks - 1000 && vEnd <= endTicks + 1000) {
                    try {
                        vClip.remove(true, false);
                        deleted++;
                    } catch (re) {}
                }
            }
        }

        app.endUndoGroup();
        return JSON.stringify({ success: true, deleted: deleted });
    } catch (e) {
        app.endUndoGroup();
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

// ============================================================
//  CAPTIONS IMPORT
// ============================================================

/**
 * Writes an SRT caption file to disk and imports it into the sequence.
 * captionsJson: JSON array of { id, startTime, endTime, text }
 */
function importCaptionsToSequence(sequenceId, captionsJson, captionStyle) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, message: "Sequence not found." });

        var captions;
        try {
            captions = JSON.parse(captionsJson);
        } catch (pe) {
            return JSON.stringify({ success: false, message: "Invalid captions JSON: " + pe.toString() });
        }

        var style;
        try {
            style = captionStyle ? JSON.parse(captionStyle) : {};
        } catch (se) {
            style = {};
        }

        // Build SRT content
        var srtContent = "";
        for (var i = 0; i < captions.length; i++) {
            var cap = captions[i];
            srtContent += (i + 1) + "\n";
            srtContent += secondsToSRTTime(cap.startTime) + " --> " + secondsToSRTTime(cap.endTime) + "\n";
            srtContent += cap.text + "\n\n";
        }

        // Write SRT file to temp folder
        var tmpFolder = getTempFolder();
        var srtPath = tmpFolder.fsName + "/flashcut_captions_" + sequenceId + ".srt";
        var srtFile = new File(srtPath);
        srtFile.encoding = "UTF-8";
        srtFile.open("w");
        srtFile.write(srtContent);
        srtFile.close();

        // Import SRT into Premiere Pro
        // Try native caption import first (PP 2022+)
        var imported = false;
        var importError = "";

        try {
            if (seq.importCaptionFile) {
                seq.importCaptionFile(srtPath, 0); // 0 = new caption track
                imported = true;
            }
        } catch (importErr) {
            importError = importErr.toString();
            log("seq.importCaptionFile failed: " + importError);
        }

        // Fallback: Import as file into project and add to sequence
        if (!imported) {
            try {
                var fileArray = new Array(srtPath);
                app.project.importFiles(fileArray, true, app.project.rootItem, false);

                // Find the imported SRT in project panel
                var srtItem = findProjectItemByName("flashcut_captions_" + sequenceId + ".srt");
                if (srtItem) {
                    app.project.activeSequence = seq;
                    // Insert at current time
                    var insertTime = "0";
                    seq.videoTracks[0].insertClip(srtItem, insertTime);
                    imported = true;
                }
            } catch (fbErr) {
                importError += " | Fallback: " + fbErr.toString();
            }
        }

        if (!imported) {
            return JSON.stringify({
                success: false,
                srtPath: srtPath,
                message: "SRT created at " + srtPath + ". Please import it manually into your sequence. Error: " + importError
            });
        }

        return JSON.stringify({
            success: true,
            srtPath: srtPath,
            captionCount: captions.length,
            message: "Captions imported successfully into sequence."
        });

    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Searches project items by name.
 */
function findProjectItemByName(name) {
    function searchItems(rootItem, targetName) {
        for (var i = 0; i < rootItem.children.numItems; i++) {
            var item = rootItem.children[i];
            if (item.name === targetName) return item;
            if (item.type === ProjectItemType.BIN) {
                var found = searchItems(item, targetName);
                if (found) return found;
            }
        }
        return null;
    }
    try {
        return searchItems(app.project.rootItem, name);
    } catch (e) {
        return null;
    }
}

// ============================================================
//  CAPTION STYLING
// ============================================================

/**
 * Finds all caption/title text layers in the sequence and applies styling.
 * styleJson: { fontName, fontSize, color, bgColor, bgOpacity, bold, italic, position, shadow }
 */
function styleCaptionsInSequence(sequenceId, styleJson) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false, message: "Sequence not found." });

        var style;
        try {
            style = JSON.parse(styleJson);
        } catch (pe) {
            return JSON.stringify({ success: false, message: "Invalid style JSON." });
        }

        app.beginUndoGroup("FlashCut AI: Style Captions");
        var styledCount = 0;
        var errors = [];

        // Look for caption tracks / text layers on video tracks
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var vTrack = seq.videoTracks[vt];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                var clip = vTrack.clips[vc];
                try {
                    var clipName = (clip.name || "").toLowerCase();
                    var isCaption = clipName.indexOf("caption") >= 0 ||
                                   clipName.indexOf("subtitle") >= 0 ||
                                   clipName.indexOf("title") >= 0 ||
                                   clipName.indexOf("text") >= 0 ||
                                   clipName.indexOf("srt") >= 0 ||
                                   clipName.indexOf("flashcut") >= 0;

                    if (!isCaption) {
                        // Check if it has MGT (Motion Graphics Template) component
                        try {
                            var component = clip.getMGTComponent();
                            if (component) isCaption = true;
                        } catch (mgtErr) {}
                    }

                    if (isCaption) {
                        applyStyleToClip(clip, style);
                        styledCount++;
                    }
                } catch (clipStyleErr) {
                    errors.push("Clip " + vc + ": " + clipStyleErr.toString());
                }
            }
        }

        // Also style caption track items
        try {
            if (seq.captionTracks) {
                for (var ct = 0; ct < seq.captionTracks.numTracks; ct++) {
                    var capTrack = seq.captionTracks[ct];
                    for (var cc = 0; cc < capTrack.clips.numItems; cc++) {
                        var capClip = capTrack.clips[cc];
                        try {
                            applyStyleToClip(capClip, style);
                            styledCount++;
                        } catch (capClipErr) {
                            errors.push("Caption clip: " + capClipErr.toString());
                        }
                    }
                }
            }
        } catch (captionTrackErr) {
            log("Caption track error: " + captionTrackErr.toString());
        }

        app.endUndoGroup();

        return JSON.stringify({
            success: true,
            styledCount: styledCount,
            errors: errors,
            message: "Styled " + styledCount + " caption layers."
        });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Applies style properties to a single clip/component.
 */
function applyStyleToClip(clip, style) {
    try {
        // Try MGT component approach
        var component = null;
        try {
            component = clip.getMGTComponent();
        } catch (e) {}

        if (component) {
            // Apply via MGT properties
            var props = component.getProperties();
            for (var p = 0; p < props.numProperties; p++) {
                var prop = props[p];
                try {
                    var propName = prop.displayName.toLowerCase();
                    if (propName.indexOf("font") >= 0 && style.fontName) {
                        prop.setValue(style.fontName);
                    } else if (propName.indexOf("size") >= 0 && style.fontSize) {
                        prop.setValue(parseFloat(style.fontSize));
                    } else if (propName.indexOf("color") >= 0 && style.color) {
                        var rgb = hexToRGB(style.color);
                        prop.setValue(rgb);
                    }
                } catch (propErr) {}
            }
        } else {
            // Try direct clip property access
            try {
                if (clip.videoComponents) {
                    for (var vc = 0; vc < clip.videoComponents.numItems; vc++) {
                        var comp = clip.videoComponents[vc];
                        var compName = (comp.displayName || "").toLowerCase();
                        if (compName.indexOf("text") >= 0 || compName.indexOf("motion") >= 0) {
                            var params = comp.properties;
                            if (params) {
                                for (var pi = 0; pi < params.numProperties; pi++) {
                                    var param = params[pi];
                                    var paramName = (param.displayName || "").toLowerCase();
                                    if (paramName.indexOf("size") >= 0 && style.fontSize) {
                                        try { param.setValue(parseFloat(style.fontSize), true); } catch (e) {}
                                    }
                                    if (paramName.indexOf("font") >= 0 && style.fontName) {
                                        try { param.setValue(style.fontName, true); } catch (e) {}
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (vcErr) {}
        }
    } catch (e) {
        log("applyStyleToClip error: " + e.toString());
    }
}

function hexToRGB(hex) {
    hex = hex.replace("#", "");
    return {
        red: parseInt(hex.substring(0, 2), 16) / 255,
        green: parseInt(hex.substring(2, 4), 16) / 255,
        blue: parseInt(hex.substring(4, 6), 16) / 255
    };
}

// ============================================================
//  TIMELINE PLAYBACK & INFO
// ============================================================

/**
 * Gets the current playhead position in seconds.
 */
function getPlayheadPosition(sequenceId) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return "0";
        var pos = seq.getPlayerPosition();
        return String(ticksToSeconds(parseFloat(pos.ticks || pos)));
    } catch (e) {
        return "0";
    }
}

/**
 * Moves playhead to a specific time (in seconds).
 */
function setPlayheadPosition(sequenceId, seconds) {
    try {
        var seq = getSequenceById(sequenceId);
        if (!seq) return JSON.stringify({ success: false });
        app.project.activeSequence = seq;
        var ticks = secondsToTicks(parseFloat(seconds));
        seq.setPlayerPosition(String(ticks));
        return JSON.stringify({ success: true });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

/**
 * Returns the path to the temp folder (so JS can write audio files there).
 */
function getTempFolderPath() {
    try {
        return getTempFolder().fsName;
    } catch (e) {
        return Folder.temp.fsName;
    }
}

/**
 * Opens a project file browser dialog and returns selected path.
 */
function browseForFile(filterDesc, filterExt) {
    try {
        var f = File.openDialog(filterDesc || "Select file", filterExt || "*");
        if (f) return f.fsName;
        return "";
    } catch (e) {
        return "";
    }
}

/**
 * Checks if a file exists on disk.
 */
function fileExists(path) {
    try {
        var f = new File(path);
        return f.exists ? "true" : "false";
    } catch (e) {
        return "false";
    }
}

/**
 * Reads a file from disk and returns its content as a base64-encoded string.
 * Used to pass audio data to the panel for Web Audio analysis.
 */
function readFileAsBase64(filePath) {
    try {
        var f = new File(filePath);
        if (!f.exists) return JSON.stringify({ success: false, message: "File not found: " + filePath });
        f.encoding = "BINARY";
        f.open("r");
        var data = f.read();
        f.close();
        // Base64 encode
        var encoded = btoa(data);
        return JSON.stringify({ success: true, data: encoded });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

// btoa polyfill for ExtendScript
function btoa(input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var output = "";
    var i = 0;
    while (i < input.length) {
        var chr1 = input.charCodeAt(i++) & 0xFF;
        var chr2 = i < input.length ? input.charCodeAt(i++) & 0xFF : 0;
        var chr3 = i < input.length ? input.charCodeAt(i++) & 0xFF : 0;
        var enc1 = chr1 >> 2;
        var enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
        var enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
        var enc4 = chr3 & 63;
        if (i - 1 >= input.length) { enc3 = enc4 = 64; }
        else if (i - 2 >= input.length) { enc4 = 64; }
        // Note: 64 means '='
        output += chars.charAt(enc1) + chars.charAt(enc2) +
                  (enc3 === 64 ? "=" : chars.charAt(enc3)) +
                  (enc4 === 64 ? "=" : chars.charAt(enc4));
    }
    return output;
}

/**
 * Writes a string to a file on disk.
 */
function writeStringToFile(filePath, content) {
    try {
        var f = new File(filePath);
        f.encoding = "UTF-8";
        f.open("w");
        f.write(content);
        f.close();
        return JSON.stringify({ success: true });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

// ============================================================
//  STARTUP CHECK
// ============================================================

/**
 * Validates Premiere Pro version and project state.
 */
function checkEnvironment() {
    try {
        var result = {
            premiereVersion: app.version || "Unknown",
            hasProject: !!app.project,
            projectName: app.project ? app.project.name : "",
            numSequences: 0,
            activeSequenceName: ""
        };

        if (app.project) {
            result.numSequences = app.project.sequences ? app.project.sequences.numSequences : 0;
            if (app.project.activeSequence) {
                result.activeSequenceName = app.project.activeSequence.name;
            }
        }

        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({ error: e.toString() });
    }
}

// Initialize on load
log("FlashCut AI ExtendScript loaded. Version 1.0.0");
