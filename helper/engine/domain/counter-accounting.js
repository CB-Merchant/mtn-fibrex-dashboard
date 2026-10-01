'use strict';

const {
  appendEvent,
  appendObservation,
  asFiniteNumber,
  localDateString,
  normalizeUsageRecord,
  upsertUsageRecords
} = require('./schema');

function addDailyBytes(dailyTotals, date, downloadBytes, uploadBytes) {
  if (!dailyTotals[date]) {
    dailyTotals[date] = {
      downloadBytes: 0,
      uploadBytes: 0,
      unattributedBytes: 0,
      totalBytes: 0
    };
  }

  dailyTotals[date].downloadBytes += downloadBytes;
  dailyTotals[date].uploadBytes += uploadBytes;
  dailyTotals[date].totalBytes += downloadBytes + uploadBytes;
}

function addDeltaAcrossDates(dailyTotals, previousAt, currentAt, downloadBytes, uploadBytes) {
  const from = previousAt ? new Date(previousAt) : null;
  const to = new Date(currentAt);
  if (!from || !Number.isFinite(from.getTime()) || from >= to) {
    addDailyBytes(dailyTotals, localDateString(to), downloadBytes, uploadBytes);
    return [localDateString(to)];
  }

  const totalDuration = to.getTime() - from.getTime();
  const touchedDates = new Set();
  let cursor = from;

  while (cursor < to) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const segmentEnd = nextMidnight < to ? nextMidnight : to;
    const ratio = (segmentEnd.getTime() - cursor.getTime()) / totalDuration;
    const segmentDownload = downloadBytes * ratio;
    const segmentUpload = uploadBytes * ratio;
    const date = localDateString(cursor);
    addDailyBytes(dailyTotals, date, segmentDownload, segmentUpload);
    touchedDates.add(date);
    cursor = segmentEnd;
  }

  return Array.from(touchedDates);
}

/* ----------------------------------------------- when a counter goes backwards

   A running total is supposed to only ever go up. When the router hands back a
   SMALLER number than last time, there are exactly two sane explanations:

     IT ROLLED OVER   the box keeps the total in a field that only holds about
                      4.29 GB, so when it fills up it goes back to zero and
                      carries on. The traffic really happened, and it is
                      (room left at the top) + (the new reading).

     IT RESTARTED     the connection dropped, or the box rebooted, and the
                      meter itself began again at zero. The traffic we can
                      prove since that moment is simply the new reading.

   What this code used to do was throw the whole period away and start again —
   the one answer guaranteed to be wrong, because it quietly binned real usage.
   Now we always credit what we can stand behind, and record which story we
   believed.

   Telling the two apart without guessing:
     - Only consider a roll-over if the reader says its counter can roll over
       at all (capabilities.counterWrapBytes). The ZTE and ZLT readers do not
       set it, so nothing about them changes.
     - A restart zeroes BOTH directions at once. A roll-over hits one direction
       at a time, because the upload and download totals never fill up at the
       same moment. So if both dropped, it was a restart.
     - A roll-over can only happen from near the top. Reading every few minutes,
       the previous value will have been very close to it, so we only accept
       that explanation from the top quarter of the range.
     - We NEVER assume it rolled over more than once. Over a long gap it may
       well have, and nothing the router sends could tell us how many times, so
       we credit what is provably true and mark the figure a MINIMUM instead of
       inventing the rest.

   That last rule is the one that needs care, because "how long was the gap?"
   decides whether a single roll-over is a FACT or merely the smallest possible
   answer:

     - Readings a few minutes apart: the line physically cannot push 4.29 GB in
       that time, so at most one roll-over can have happened. The figure is
       exact.
     - Readings hours apart (the PC was off): the line had time to fill that
       field over and over. One roll-over is then only the FLOOR, and the day
       must say so.

   We settle it with arithmetic rather than a hunch — the fastest speed this
   line has ever actually been measured at, doubled for headroom, times the
   length of the gap. If even that generous figure cannot fill the counter a
   second time, one roll-over is the only possibility.                       */

const WRAP_ONLY_FROM_TOP_FRACTION = 0.75;
const WRAP_SPEED_HEADROOM = 2;      // assume the line could have run twice its best measured speed
const FALLBACK_LINE_MBPS = 100;     // used only when we have never measured this line at all
const SECONDS_PER_DAY = 86400;

/* The fastest this line has ever been seen running, in bytes per second, with
   generous headroom. Speed tests are the only real evidence we have of what the
   link can do; if there are none yet we assume a fast home line, which errs
   towards labelling a figure a minimum rather than overstating it as exact. */
function fastestPlausibleBytesPerSecond(state) {
  const tests = state && state.settings && state.settings.speedTests;
  let bestMbps = 0;
  if (Array.isArray(tests)) {
    for (const t of tests) {
      const down = Number(t && t.downMbps);
      const up = Number(t && t.upMbps);
      if (Number.isFinite(down) && down > bestMbps) bestMbps = down;
      if (Number.isFinite(up) && up > bestMbps) bestMbps = up;
    }
  }
  if (!(bestMbps > 0)) bestMbps = FALLBACK_LINE_MBPS;
  return (bestMbps * WRAP_SPEED_HEADROOM * 1e6) / 8;
}

/* ---------------------------------------------------- the "best estimate" rate

   When the PC was off, the counter's low digits are known exactly but the number
   of full laps is not. The single most useful clue we have to how many laps
   happened is how much this line NORMALLY moves in a day. We take that from the
   days we DID measure with confidence — not from other estimates or minimums,
   which would let a guess feed on a guess — and per direction, because download
   and upload move at very different volumes and wrap independently.

   Returns bytes/second, or null when there is no confident history to lean on
   (in which case we do NOT estimate — we fall back to the provable one-lap
   minimum, and say so).                                                       */
function typicalBytesPerSecond(state, direction) {
  const records = state && Array.isArray(state.records) ? state.records : [];
  const field = direction === 'up' ? 'uploadBytes' : 'downloadBytes';
  let total = 0;
  let days = 0;
  for (const r of records) {
    if (!r || r.confidence !== 'observed') continue;   // only fully-trusted days
    const bytes = Number(r[field]);
    if (!Number.isFinite(bytes) || bytes < 0) continue;
    total += bytes;
    days += 1;
  }
  if (days < 1 || !(total > 0)) return null;
  return (total / days) / SECONDS_PER_DAY;
}

/* Could the counter have gone round MORE than once while we weren't looking? */
function onlyOneRollOverWasPossible({ wrapBytes, gapSeconds, maxBytesPerSecond }) {
  if (!(wrapBytes > 0)) return false;
  if (!(gapSeconds > 0)) return true;                  // same instant — nothing could have passed
  const rate = maxBytesPerSecond > 0 ? maxBytesPerSecond : (FALLBACK_LINE_MBPS * 1e6) / 8;
  return gapSeconds * rate < wrapBytes;                // not even one extra lap was physically possible
}

/* How many laps most likely happened, judging by how much this line normally
   moves? We know the low digits (oneLapBytes = the provable floor). We look for
   the whole number of EXTRA laps whose total lands closest to "typical rate ×
   gap", never fewer than zero and never more than the line could physically
   have pushed. Returns the total estimated bytes and lap count, or null when we
   have nothing to base a guess on. */
function estimateBytesAcrossWraps({
  oneLapBytes, wrapBytes, gapSeconds, typicalRate, maxBytesPerSecond
}) {
  if (!(typicalRate > 0) || !(wrapBytes > 0) || !(gapSeconds > 0)) return null;
  const expected = typicalRate * gapSeconds;
  // extra laps ≈ (expected − one lap) / one full range, rounded to nearest whole
  let extraLaps = Math.round((expected - oneLapBytes) / wrapBytes);
  if (extraLaps < 1) return null;                      // typical rate says one lap is plenty
  // Never claim more than the link could physically have carried in the gap.
  if (maxBytesPerSecond > 0) {
    const ceiling = Math.floor((gapSeconds * maxBytesPerSecond - oneLapBytes) / wrapBytes);
    if (extraLaps > ceiling) extraLaps = ceiling;
  }
  if (extraLaps < 1) return null;
  return { bytes: oneLapBytes + extraLaps * wrapBytes, laps: extraLaps + 1 };
}

function accountDirection({
  previousValue, currentValue, bothWentBackwards, wrapBytes,
  gapSeconds = 0, maxBytesPerSecond = 0, typicalRate = 0
}) {
  const previous = Number(previousValue) || 0;
  const current = Number(currentValue) || 0;
  if (current >= previous) return { bytes: current - previous, reason: 'counted' };

  const rollOverIsTheBetterStory = wrapBytes > 0
    && !bothWentBackwards
    && previous >= wrapBytes * WRAP_ONLY_FROM_TOP_FRACTION
    && previous < wrapBytes;

  if (rollOverIsTheBetterStory) {
    // One lap is what we can PROVE — the floor, credited no matter what.
    const oneLapBytes = (wrapBytes - previous) + current;
    const certain = onlyOneRollOverWasPossible({ wrapBytes, gapSeconds, maxBytesPerSecond });
    if (certain) {
      // Short gap: a second lap was physically impossible, so one lap is exact.
      return { bytes: oneLapBytes, reason: 'rolled-over', isMinimum: false };
    }
    // Long gap: the meter could have gone round more than once. Use the line's
    // normal daily rate to estimate the most likely number of laps. The one-lap
    // figure is kept as the guaranteed floor beneath the estimate.
    const est = estimateBytesAcrossWraps({
      oneLapBytes, wrapBytes, gapSeconds, typicalRate, maxBytesPerSecond
    });
    if (est) {
      return {
        bytes: est.bytes,
        minimumBytes: oneLapBytes,
        reason: 'rolled-over',
        isEstimate: true,
        estimatedLaps: est.laps,
        estimateReason: 'multiple-wraps-estimated'
      };
    }
    // No confident history to estimate from — stay honest with the bare floor.
    return {
      bytes: oneLapBytes,
      reason: 'rolled-over',
      isMinimum: true,
      minimumReason: 'multiple-wraps-possible'
    };
  }

  // Whatever ran between the last reading and the moment the meter restarted
  // is gone for good — nobody recorded it. The new reading is therefore a
  // floor, not the whole truth, and is labelled as such.
  return { bytes: current, reason: 'restarted', isMinimum: true, minimumReason: 'meter-restarted' };
}

function createEpochId(sourceId, observedAt) {
  return `${sourceId}:${observedAt.replace(/[^0-9]/g, '').substring(0, 14)}`;
}

function dailyRecordFor(source, date, totals, observedAt) {
  const downloadBytes = Math.max(0, Math.round(totals.downloadBytes || 0));
  const uploadBytes = Math.max(0, Math.round(totals.uploadBytes || 0));
  const unattributedBytes = Math.max(0, Math.round(totals.unattributedBytes || 0));
  const usageBytes = downloadBytes + uploadBytes + unattributedBytes;
  const usageGB = (usageBytes / (1024 * 1024 * 1024)).toFixed(2);
  const isMinimum = Boolean(totals.isMinimum);
  const isEstimate = Boolean(totals.isEstimate) && !isMinimum;
  const wrapsUncounted = totals.minimumReason === 'multiple-wraps-possible';
  const minimumNote = !isMinimum
    ? ''
    : (wrapsUncounted
      ? ' — AT LEAST this much: the helper was not running for part of this period,'
        + ' and the router\'s own meter only counts up to 4.29 GB before starting'
        + ' again, so it may have gone round more than once while nothing was watching.'
      : ' — AT LEAST this much: the router\'s own meter started again during'
        + ' this period, so whatever ran before it restarted could not be counted.');
  // An estimate is our best guess of the real figure for a PC-off stretch, worked
  // out from this line's normal daily usage. Say so plainly — it is neither an
  // exact reading nor a bare minimum.
  const estimateNote = isEstimate
    ? ' — ESTIMATE: the PC was off for part of this period and the router\'s meter'
      + ' rolled over more than once. The most likely figure was worked out from'
      + ' your normal daily usage, so treat it as a close guess, not an exact count.'
    : '';
  const confidence = isMinimum ? 'observed-minimum' : (isEstimate ? 'observed-estimate' : 'observed');
  return normalizeUsageRecord({
    date,
    usageBytes,
    downloadBytes,
    uploadBytes,
    observedAt,
    confidence,
    granularity: 'day',
    provenance: source.id,
    rawMessage: `${source.label} counters: ${usageGB} GB observed (download ${
      (downloadBytes / (1024 * 1024 * 1024)).toFixed(2)
    } GB, upload ${(uploadBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)${minimumNote}${estimateNote}`
  }, source);
}

function ingestCounterSnapshot(state, snapshot, source) {
  const sourceId = source.id;
  const observedAt = snapshot.observedAt || new Date().toISOString();
  const currentRx = asFiniteNumber(snapshot.downloadBytes ?? snapshot.rxBytes);
  const currentTx = asFiniteNumber(snapshot.uploadBytes ?? snapshot.txBytes);
  if (currentRx === null || currentTx === null || currentRx < 0 || currentTx < 0) {
    throw new Error(`Collector ${sourceId} returned invalid cumulative counters.`);
  }

  const currentUptime = asFiniteNumber(snapshot.uptimeSeconds ?? snapshot.upTime);
  const currentCounterScope = snapshot.counterScope || 'wan';
  const routerIp = snapshot.routerIp || source.routerIp || null;
  const previous = state.accounting[sourceId] || null;
  const previousObservation = previous?.lastObservation || null;
  const dailyTotals = { ...(previous?.dailyTotals || {}) };
  const touchedDates = [];
  let status = 'baseline';
  let event = null;
  let epochId = previous?.epochId || createEpochId(sourceId, observedAt);

  const hasPrevious = Boolean(previousObservation);
  const sourceChanged = hasPrevious && previousObservation.routerIp !== routerIp;
  const counterScopeChanged = hasPrevious &&
    (previousObservation.counterScope || 'wan') !== currentCounterScope;
  const uptimeReset = hasPrevious && currentUptime !== null && previousObservation.uptimeSeconds !== null &&
    currentUptime < Number(previousObservation.uptimeSeconds);

  // The ZTE collector can retain WAN counters as a diagnostic fallback when
  // its access pages are temporarily unavailable. Do not replace the access
  // cursor with that smaller/incompatible counter: the next access snapshot
  // can then account for the whole interval without losing the fallback gap.
  const accessCollectorUsingWanFallback = hasPrevious &&
    source.capabilities?.counterScope === 'access' &&
    currentCounterScope === 'wan' &&
    (previousObservation.counterScope || 'wan') === 'access';

  if (accessCollectorUsingWanFallback) {
    const observation = {
      id: `${sourceId}:${observedAt}`,
      sourceId,
      sourceType: source.kind,
      sourceLabel: source.label,
      routerIp,
      observedAt,
      epochId: previous.epochId,
      downloadBytes: Math.round(currentRx),
      uploadBytes: Math.round(currentTx),
      totalBytes: Math.round(currentRx + currentTx),
      uptimeSeconds: currentUptime,
      connectionStatus: snapshot.connectionStatus || 'Unknown',
      counterScope: currentCounterScope,
      counterDetails: snapshot.counterDetails || null
    };
    const event = {
      type: 'counter-fallback',
      sourceId,
      occurredAt: observedAt,
      details: {
        routerIp,
        previousCounterScope: previousObservation.counterScope || 'wan',
        fallbackCounterScope: currentCounterScope,
        accessError: snapshot.counterDetails?.accessError || null,
        accessCursorPreserved: true
      }
    };
    appendObservation(state, observation);
    state.accounting[sourceId] = {
      ...previous,
      lastStatus: 'access-counters-unavailable',
      lastSeenAt: observedAt,
      lastDiagnosticObservation: observation
    };
    appendEvent(state, event);
    return {
      status: 'access-counters-unavailable',
      records: [],
      observation,
      event,
      dailyTotals
    };
  }

  if (!hasPrevious || sourceChanged || counterScopeChanged) {
    /* A first-ever reading, a different box, or a different kind of meter.
       In every one of these the old number and the new number are not measuring
       the same thing, so there is no period to fill in — only a new starting
       point to remember. (A meter that merely RESTARTED is a different case and
       is handled below, because that one we can still account for.) */
    epochId = createEpochId(sourceId, observedAt);
    status = !hasPrevious
      ? 'baseline'
      : (sourceChanged ? 'source-changed' : 'counter-scope-changed');
    event = {
      type: status,
      sourceId,
      occurredAt: observedAt,
      details: {
        routerIp,
        previousRouterIp: previousObservation?.routerIp || null,
        previousDownloadBytes: previousObservation?.downloadBytes ?? null,
        previousUploadBytes: previousObservation?.uploadBytes ?? null,
        currentDownloadBytes: currentRx,
        currentUploadBytes: currentTx,
        previousUptimeSeconds: previousObservation?.uptimeSeconds ?? null,
        currentUptimeSeconds: currentUptime,
        previousCounterScope: previousObservation?.counterScope || 'wan',
        currentCounterScope
      }
    };
  } else {
    /* The same meter on the same box. However long ago the last reading was —
       three minutes or three weeks with the PC switched off — the router kept
       counting the whole time, so the difference between then and now IS the
       usage for that whole period. addDeltaAcrossDates then shares it out over
       every day in between, in proportion to how much of the period fell on
       each day. That is what makes the helper catch up by itself when it comes
       back on. */
    const previousDownload = Number(previousObservation.downloadBytes);
    const previousUpload = Number(previousObservation.uploadBytes);
    const wrapBytes = asFiniteNumber(source.capabilities?.counterWrapBytes) || 0;
    const bothWentBackwards = currentRx < previousDownload && currentTx < previousUpload;

    // How long were we not looking, and how much could the line have moved in
    // that time? Together these decide whether a roll-over is an exact figure
    // or only a floor.
    const gapSeconds = Math.max(
      0,
      (new Date(observedAt).getTime() - new Date(previousObservation.observedAt).getTime()) / 1000
    );
    const maxBytesPerSecond = fastestPlausibleBytesPerSecond(state);

    const down = accountDirection({
      previousValue: previousDownload, currentValue: currentRx,
      bothWentBackwards, wrapBytes, gapSeconds, maxBytesPerSecond,
      typicalRate: typicalBytesPerSecond(state, 'down')
    });
    const up = accountDirection({
      previousValue: previousUpload, currentValue: currentTx,
      bothWentBackwards, wrapBytes, gapSeconds, maxBytesPerSecond,
      typicalRate: typicalBytesPerSecond(state, 'up')
    });
    const restarted = down.reason === 'restarted' || up.reason === 'restarted';
    const rolledOver = down.reason === 'rolled-over' || up.reason === 'rolled-over';
    const isMinimum = Boolean(down.isMinimum || up.isMinimum);
    const isEstimate = Boolean(down.isEstimate || up.isEstimate);
    // A restart is the more serious caveat, so it wins the wording.
    const minimumReason = (down.minimumReason === 'meter-restarted' || up.minimumReason === 'meter-restarted')
      ? 'meter-restarted'
      : (down.minimumReason || up.minimumReason || null);
    // The provable floor beneath an estimate, direction by direction. When a
    // direction was not estimated its plain bytes ARE its floor.
    const minimumDownBytes = down.isEstimate ? down.minimumBytes : down.bytes;
    const minimumUpBytes = up.isEstimate ? up.minimumBytes : up.bytes;

    const dates = addDeltaAcrossDates(
      dailyTotals,
      previousObservation.observedAt,
      observedAt,
      down.bytes,
      up.bytes
    );
    touchedDates.push(...dates);
    // Mark every day this touched, so the figure is never later presented as
    // an exact measurement when it is really a floor or a best guess.
    if (isMinimum) dates.forEach(date => {
      dailyTotals[date].isMinimum = true;
      dailyTotals[date].minimumReason = minimumReason;
    });
    // An estimate is NOT a minimum — it is our best guess of the real number,
    // with the provable floor kept alongside it. (A restart on one direction can
    // make the same day both; the minimum flag above then wins, as it should.)
    if (isEstimate && !isMinimum) dates.forEach(date => {
      dailyTotals[date].isEstimate = true;
      dailyTotals[date].estimateReason = 'multiple-wraps-estimated';
    });

    if (restarted) {
      // The meter began again, so a new run of readings starts here — but the
      // bytes above have still been credited rather than thrown away.
      epochId = createEpochId(sourceId, observedAt);
      status = 'counter-reset';
    } else if (rolledOver) {
      status = 'counter-wrapped';
    } else {
      status = uptimeReset ? 'uptime-reset' : (down.bytes + up.bytes > 0 ? 'updated' : 'unchanged');
    }

    if (restarted || rolledOver) {
      event = {
        type: status,
        sourceId,
        occurredAt: observedAt,
        details: {
          routerIp,
          previousDownloadBytes: previousDownload,
          previousUploadBytes: previousUpload,
          currentDownloadBytes: currentRx,
          currentUploadBytes: currentTx,
          previousObservedAt: previousObservation.observedAt,
          creditedDownloadBytes: Math.round(down.bytes),
          creditedUploadBytes: Math.round(up.bytes),
          minimumDownloadBytes: Math.round(minimumDownBytes),
          minimumUploadBytes: Math.round(minimumUpBytes),
          downloadReason: down.reason,
          uploadReason: up.reason,
          counterWrapBytes: wrapBytes || null,
          gapAccounted: true,
          figureIsMinimum: isMinimum,
          figureIsEstimate: isEstimate && !isMinimum,
          estimatedLaps: (down.estimatedLaps || up.estimatedLaps || null),
          minimumReason,
          gapSeconds: Math.round(gapSeconds),
          fastestPlausibleBytesPerSecond: Math.round(maxBytesPerSecond),
          previousUptimeSeconds: previousObservation.uptimeSeconds ?? null,
          currentUptimeSeconds: currentUptime,
          note: restarted
            ? 'The router\'s meter started again from zero. The traffic since it '
              + 'restarted has been counted; anything before that is unrecoverable, '
              + 'so this period is a minimum.'
            : (isMinimum
              ? 'The router\'s meter filled up and rolled back to zero. One full lap '
                + 'has been added, but the gap was long enough that it could have gone '
                + 'round more than once, so this period is a minimum.'
              : (isEstimate
                ? 'The router\'s meter filled up and rolled back to zero while the PC '
                  + 'was off. The number of times it went round was estimated from this '
                  + 'line\'s normal daily usage, so this period is a best estimate, not '
                  + 'an exact figure. The provable minimum is kept alongside it.'
                : 'The router\'s meter filled up and rolled back to zero. The traffic '
                  + 'either side of that point has been added together.'))
        }
      };
    } else if (uptimeReset) {
      event = {
        type: 'uptime-reset',
        sourceId,
        occurredAt: observedAt,
        details: {
          previousUptimeSeconds: previousObservation.uptimeSeconds,
          currentUptimeSeconds: currentUptime,
          countersContinued: true
        }
      };
    }
  }

  const observation = {
    id: `${sourceId}:${observedAt}`,
    sourceId,
    sourceType: source.kind,
    sourceLabel: source.label,
    routerIp,
    observedAt,
    epochId,
    downloadBytes: Math.round(currentRx),
    uploadBytes: Math.round(currentTx),
    totalBytes: Math.round(currentRx + currentTx),
    uptimeSeconds: currentUptime,
    connectionStatus: snapshot.connectionStatus || 'Unknown',
    counterScope: currentCounterScope,
    counterDetails: snapshot.counterDetails || null
  };

  state.accounting[sourceId] = {
    sourceId,
    routerIp,
    epochId,
    dailyTotals,
    lastObservation: observation,
    lastStatus: status,
    lastSeenAt: observedAt
  };
  appendObservation(state, observation);
  if (event) appendEvent(state, event);

  const records = touchedDates
    .filter(date => dailyTotals[date] && dailyTotals[date].totalBytes > 0)
    .map(date => dailyRecordFor(source, date, dailyTotals[date], observedAt));
  upsertUsageRecords(state, records, source);

  return {
    status,
    records,
    observation,
    event,
    dailyTotals
  };
}

module.exports = {
  accountDirection,
  addDeltaAcrossDates,
  fastestPlausibleBytesPerSecond,
  typicalBytesPerSecond,
  estimateBytesAcrossWraps,
  onlyOneRollOverWasPossible,
  ingestCounterSnapshot
};
