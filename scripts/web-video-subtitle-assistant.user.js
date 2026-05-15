// ==UserScript==
// @name         Web Video Subtitle Assistant (ZH/EN)
// @namespace    https://example.local/web-video-subtitle-assistant
// @version      1.0.0
// @description  Collect current-page video subtitles in Chinese and English, export them as files, and generate an extractive summary.
// @author       OpenAI
// @match        *://*/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    scanIntervalMs: 700,
    maxDomCaptionLength: 500,
    summarySentenceLimit: 8,
    uiId: 'wvsa-panel',
    selectors: [
      '.ytp-caption-segment',
      '.caption-window',
      '.captions-text',
      '.vjs-text-track-display',
      '.jw-text-track-display',
      '[class*="caption" i]',
      '[class*="subtitle" i]',
      '[aria-live="polite"]',
    ],
  };

  const state = {
    cues: new Map(),
    running: false,
    timer: null,
    observedVideos: new WeakSet(),
    trackHandlers: new WeakMap(),
    domLastText: '',
    domLastAt: 0,
    ui: {},
  };

  const normalizeText = (text) => text
    .replace(/\s+/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .trim();

  const hasChinese = (text) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
  const hasEnglish = (text) => /[A-Za-z]/.test(text);
  const isZhOrEn = (text) => hasChinese(text) || hasEnglish(text);

  const formatTime = (seconds = 0) => {
    const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const hh = Math.floor(safeSeconds / 3600);
    const mm = Math.floor((safeSeconds % 3600) / 60);
    const ss = Math.floor(safeSeconds % 60);
    const ms = Math.floor((safeSeconds % 1) * 1000);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };

  const makeKey = ({ source, start, end, text }) => [
    source,
    Number(start || 0).toFixed(2),
    Number(end || start || 0).toFixed(2),
    text,
  ].join('|');

  const addCue = ({ source, lang = 'unknown', start = 0, end = 0, text }) => {
    const clean = normalizeText(text || '');
    if (!clean || !isZhOrEn(clean)) return false;

    const cue = {
      source,
      lang: lang || (hasChinese(clean) ? 'zh' : 'en'),
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : start || 0,
      text: clean,
      capturedAt: new Date().toISOString(),
    };

    const key = makeKey(cue);
    if (state.cues.has(key)) return false;
    state.cues.set(key, cue);
    renderStats();
    return true;
  };

  const sortedCues = () => [...state.cues.values()].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.text.localeCompare(b.text);
  });

  const collectFromTextTracks = () => {
    document.querySelectorAll('video').forEach((video, videoIndex) => {
      if (!state.observedVideos.has(video)) {
        state.observedVideos.add(video);
        [...video.textTracks].forEach((track) => {
          try {
            track.mode = 'hidden';
          } catch (error) {
            // Some sites block mode changes. Collection can still continue from visible DOM captions.
          }
        });
      }

      [...video.textTracks].forEach((track, trackIndex) => {
        const label = track.label || track.language || `track-${trackIndex + 1}`;
        const lang = track.language || label;
        const cues = track.cues || track.activeCues || [];

        [...cues].forEach((cue) => addCue({
          source: `video-${videoIndex + 1}:${label}`,
          lang,
          start: cue.startTime,
          end: cue.endTime,
          text: cue.text,
        }));

        if (!state.trackHandlers.has(track)) {
          const handler = () => {
            [...(track.activeCues || [])].forEach((cue) => addCue({
              source: `video-${videoIndex + 1}:${label}`,
              lang,
              start: cue.startTime,
              end: cue.endTime,
              text: cue.text,
            }));
          };
          track.addEventListener('cuechange', handler);
          state.trackHandlers.set(track, handler);
        }
      });
    });
  };

  const collectFromDomCaptions = () => {
    const now = performance.now();
    const candidates = CONFIG.selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element) => element && element.offsetParent !== null)
      .map((element) => normalizeText(element.innerText || element.textContent || ''))
      .filter((text) => text && text.length <= CONFIG.maxDomCaptionLength && isZhOrEn(text));

    const combined = normalizeText([...new Set(candidates)].join(' '));
    if (!combined || combined === state.domLastText || now - state.domLastAt < 250) return;

    const currentVideo = document.querySelector('video');
    addCue({
      source: 'visible-caption-dom',
      lang: hasChinese(combined) ? 'zh/en' : 'en',
      start: currentVideo?.currentTime || 0,
      end: currentVideo?.currentTime || 0,
      text: combined,
    });
    state.domLastText = combined;
    state.domLastAt = now;
  };

  const scan = () => {
    collectFromTextTracks();
    collectFromDomCaptions();
  };

  const toText = () => sortedCues()
    .map((cue) => `[${formatTime(cue.start)} - ${formatTime(cue.end)}] ${cue.text}`)
    .join('\n');

  const splitSentences = (text) => normalizeText(text)
    .split(/(?<=[。！？.!?])\s+|(?<=[。！？.!?])/u)
    .map((sentence) => normalizeText(sentence))
    .filter((sentence) => sentence.length >= 8);

  const tokenize = (text) => {
    const english = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    const chinese = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2}/g) || [];
    const stopWords = new Set([
      'the', 'and', 'that', 'this', 'with', 'you', 'are', 'for', 'but', 'not', 'have', 'from',
      'they', 'will', 'your', 'can', 'all', 'was', 'our', 'about', 'just', 'what', 'when',
      '一个', '我们', '你们', '他们', '这个', '那个', '以及', '因为', '所以', '但是', '如果', '就是',
    ]);
    return [...english, ...chinese].filter((token) => !stopWords.has(token));
  };

  const summarize = () => {
    const transcript = sortedCues().map((cue) => cue.text).join(' ');
    const sentences = splitSentences(transcript);
    if (sentences.length === 0) return '暂无足够字幕内容可总结。';

    const frequencies = new Map();
    sentences.flatMap(tokenize).forEach((token) => {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    });

    const ranked = sentences.map((sentence, index) => {
      const tokens = tokenize(sentence);
      const score = tokens.reduce((sum, token) => sum + (frequencies.get(token) || 0), 0) / Math.max(1, tokens.length);
      return { sentence, index, score };
    });

    const picked = ranked
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, Math.min(CONFIG.summarySentenceLimit, ranked.length))
      .sort((a, b) => a.index - b.index)
      .map((item) => `- ${item.sentence}`);

    return [
      `字幕条数：${state.cues.size}`,
      `覆盖时间：${formatTime(sortedCues()[0]?.start || 0)} - ${formatTime(sortedCues().at(-1)?.end || sortedCues().at(-1)?.start || 0)}`,
      '',
      '内容要点：',
      ...picked,
    ].join('\n');
  };

  const download = (filename, content, type = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const safeTitle = () => normalizeText(document.title || 'video-subtitles')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 80) || 'video-subtitles';

  const exportTranscript = () => download(`${safeTitle()}-subtitles.txt`, toText());
  const exportJson = () => download(`${safeTitle()}-subtitles.json`, JSON.stringify(sortedCues(), null, 2), 'application/json;charset=utf-8');
  const exportSummary = () => download(`${safeTitle()}-summary.txt`, summarize());

  const renderStats = () => {
    if (!state.ui.stats) return;
    const zhCount = sortedCues().filter((cue) => hasChinese(cue.text)).length;
    const enCount = sortedCues().filter((cue) => !hasChinese(cue.text) && hasEnglish(cue.text)).length;
    state.ui.stats.textContent = `已收集 ${state.cues.size} 条（中文/双语 ${zhCount}，英文 ${enCount}）`;
  };

  const start = () => {
    if (state.running) return;
    state.running = true;
    state.timer = window.setInterval(scan, CONFIG.scanIntervalMs);
    scan();
    state.ui.toggle.textContent = '暂停识别';
  };

  const stop = () => {
    state.running = false;
    window.clearInterval(state.timer);
    state.timer = null;
    state.ui.toggle.textContent = '开始识别';
  };

  const createButton = (label, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    Object.assign(button.style, {
      border: '1px solid #60a5fa',
      borderRadius: '8px',
      background: '#1d4ed8',
      color: '#fff',
      cursor: 'pointer',
      padding: '6px 8px',
      fontSize: '12px',
    });
    return button;
  };

  const buildUi = () => {
    if (document.getElementById(CONFIG.uiId)) return;

    const panel = document.createElement('section');
    panel.id = CONFIG.uiId;
    Object.assign(panel.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '260px',
      padding: '12px',
      borderRadius: '12px',
      boxShadow: '0 16px 40px rgba(15, 23, 42, 0.35)',
      background: 'rgba(15, 23, 42, 0.92)',
      color: '#e5e7eb',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '13px',
      lineHeight: '1.5',
    });

    const title = document.createElement('strong');
    title.textContent = '字幕识别助手';
    title.style.display = 'block';
    title.style.marginBottom = '6px';

    const note = document.createElement('p');
    note.textContent = '自动收集当前网页视频的中文/英文字幕，并可导出字幕、JSON 和摘要。';
    note.style.margin = '0 0 8px';
    note.style.color = '#cbd5e1';

    const stats = document.createElement('div');
    stats.style.marginBottom = '8px';
    stats.style.color = '#bfdbfe';

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '6px',
    });

    const toggle = createButton('开始识别', () => (state.running ? stop() : start()));
    const transcript = createButton('导出字幕', exportTranscript);
    const json = createButton('导出 JSON', exportJson);
    const summary = createButton('导出摘要', exportSummary);
    const clear = createButton('清空', () => {
      state.cues.clear();
      state.domLastText = '';
      renderStats();
    });
    clear.style.background = '#475569';
    clear.style.borderColor = '#94a3b8';

    actions.append(toggle, transcript, json, summary, clear);
    panel.append(title, note, stats, actions);
    document.body.append(panel);

    state.ui = { panel, stats, toggle };
    renderStats();
  };

  const initialize = () => {
    buildUi();
    start();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
