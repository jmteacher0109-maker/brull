// ============================================================================
// 🔥 브롤스튜던츠 - 온라인 PvP (pvp-online.js)
// Firebase Realtime Database 기반 실시간 대전
// ============================================================================

const firebaseConfig = {
  apiKey: "AIzaSyCbkXyFyjSWwfXSpoFcEG38LOxqSa0J0sw",
  authDomain: "mathk-1e5d1.firebaseapp.com",
  databaseURL: "https://mathk-1e5d1-default-rtdb.firebaseio.com",
  projectId: "mathk-1e5d1",
  storageBucket: "mathk-1e5d1.firebasestorage.app",
  messagingSenderId: "433859326",
  appId: "1:433859326:web:88abca82a506e116af93af"
};

// ─── Firebase 초기화 ───────────────────────────────────────────────────────
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ─── 온라인 PvP 상태 ───────────────────────────────────────────────────────
const onlinePvp = {
  playerId: null,       // 'player1' | 'player2'
  roomId: null,
  nickname: '',
  character: null,
  roomRef: null,
  unsubscribes: [],     // 리스너 해제 함수 모음

  // 게임 진행
  currentQuestionIdx: 0,
  myCorrect: 0,
  oppCorrect: 0,
  answered: false,      // 현재 문제에 답했는지
  questionStartTime: 0,
  timerInterval: null,
  hintUsed: false,
};

const ONLINE_WIN_COUNT = 3;   // 먼저 3문제 맞히면 승리
const ONLINE_TOTAL_Q  = 5;    // 총 5문제

// ─── 유틸 ─────────────────────────────────────────────────────────────────
function genRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function clearOnlineListeners() {
  onlinePvp.unsubscribes.forEach(fn => fn());
  onlinePvp.unsubscribes = [];
}

function stopOnlineTimer() {
  if (onlinePvp.timerInterval) {
    clearInterval(onlinePvp.timerInterval);
    onlinePvp.timerInterval = null;
  }
}

// ─── 입장: 닉네임 화면 표시 ────────────────────────────────────────────────
function showOnlineLobby() {
  showScreen('onlineLobbyScreen');
  // 캐릭터 그리드 렌더링
  const grid = document.getElementById('lobbyCharGrid');
  grid.innerHTML = CHARACTERS.map(c => `
    <div class="lobby-char-card" data-id="${c.id}">
      <span class="lobby-char-emoji">${c.emoji}</span>
      <div class="lobby-char-name">${c.name}</div>
      <div class="lobby-char-power">${c.power}</div>
    </div>`).join('');

  grid.querySelectorAll('.lobby-char-card').forEach(card => {
    card.addEventListener('click', () => {
      grid.querySelectorAll('.lobby-char-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      onlinePvp.character = CHARACTERS.find(c => c.id === card.dataset.id);
      checkLobbyReady();
    });
  });

  document.getElementById('lobbyNickname').addEventListener('input', checkLobbyReady);
  document.getElementById('lobbyStartBtn').addEventListener('click', enterMatchmaking);
}

function checkLobbyReady() {
  const nick = document.getElementById('lobbyNickname').value.trim();
  const btn  = document.getElementById('lobbyStartBtn');
  btn.disabled = !(nick && onlinePvp.character);
}

// ─── 매칭 시작 ────────────────────────────────────────────────────────────
async function enterMatchmaking() {
  const nick = document.getElementById('lobbyNickname').value.trim();
  if (!nick || !onlinePvp.character) return;
  onlinePvp.nickname = nick;

  showScreen('matchmakingScreen');
  document.getElementById('matchmakingStatus').textContent = '🔍 상대를 찾는 중...';
  document.getElementById('matchmakingNick').textContent = `${onlinePvp.character.emoji} ${nick}`;

  // ★ 버그1 수정: 난이도별로 독립된 대기열 사용
  const diff = gameState.difficulty || 'easy';
  const waitingRef = db.ref(`waiting_${diff}`);

  try {
    const snapshot = await waitingRef.once('value');
    const waiting  = snapshot.val();

    if (waiting) {
      // ── player2: 기존 대기방 참여 ──
      const roomId = Object.keys(waiting)[0];

      onlinePvp.roomId  = roomId;
      onlinePvp.playerId = 'player2';
      onlinePvp.roomRef  = db.ref(`rooms/${roomId}`);

      // 대기 목록에서 즉시 제거 (다른 player2가 같은 방에 못 들어오게)
      await db.ref(`waiting_${diff}/${roomId}`).remove();

      // 문제 목록 생성 (player2 담당)
      const questions = pickOnlineQuestions();

      await onlinePvp.roomRef.update({
        player2: {
          nickname: nick,
          emoji: onlinePvp.character.emoji,
          characterId: onlinePvp.character.id,
          correct: 0,
        },
        questions: questions.map(q => ({
          text: q.text, answer: q.answer,
          topic: q.topic, hint: q.hint,
          choices: q.choices || null,
        })),
        status: 'playing',
        currentQ: 0,
        player1Answered: false,
        player2Answered: false,
        player1Time: null,
        player2Time: null,
      });

      setupDisconnectCleanup(diff);

      // ★ player2는 방 업데이트 완료 후 바로 게임 시작
      const roomSnap = await onlinePvp.roomRef.once('value');
      const room = roomSnap.val();
      onlinePvp._gameStarted = true;
      startOnlineGame(room);
      // 게임 진행 리스너 연결
      listenGameRoom();

    } else {
      // ── player1: 새 방 생성 후 상대 대기 ──
      const roomId = genRoomId();
      onlinePvp.roomId  = roomId;
      onlinePvp.playerId = 'player1';
      onlinePvp.roomRef  = db.ref(`rooms/${roomId}`);

      await onlinePvp.roomRef.set({
        player1: {
          nickname: nick,
          emoji: onlinePvp.character.emoji,
          characterId: onlinePvp.character.id,
          correct: 0,
        },
        status: 'waiting',
        difficulty: diff,
        createdAt: Date.now(),
      });

      await db.ref(`waiting_${diff}/${roomId}`).set({ createdAt: Date.now() });

      setupDisconnectCleanup(diff);
      // ★ 버그2 수정: player1은 상대 입장 대기 리스너 → 게임 시작 후 게임 리스너로 교체
      listenForMatchThenGame();
    }

  } catch (err) {
    console.error(err);
    alert('매칭 중 오류가 발생했어요. 다시 시도해주세요.');
    showScreen('onlineLobbyScreen');
  }
}

function setupDisconnectCleanup(diff) {
  if (onlinePvp.playerId === 'player1') {
    db.ref(`waiting_${diff}/${onlinePvp.roomId}`).onDisconnect().remove();
  }
  onlinePvp.roomRef.onDisconnect().update({ status: 'disconnected' });
}

// ★ 버그2 수정 핵심: player1 전용 - 매칭 대기만 감지, 게임 시작되면 리스너 교체
function listenForMatchThenGame() {
  const ref = onlinePvp.roomRef.child('status');

  const handler = ref.on('value', snap => {
    const status = snap.val();
    if (status === 'playing') {
      // 매칭 완료 → 이 리스너 즉시 해제
      ref.off('value', handler);

      // 방 전체 정보 한 번 읽어서 게임 시작
      onlinePvp.roomRef.once('value').then(roomSnap => {
        const room = roomSnap.val();
        if (room && room.questions) {
          onlinePvp._gameStarted = true;
          startOnlineGame(room);
          // 게임 진행 리스너 새로 연결
          listenGameRoom();
        }
      });
    } else if (status === 'disconnected') {
      ref.off('value', handler);
      showOnlineResult('disconnect');
    }
  });

  // 취소 가능하도록 등록
  onlinePvp.unsubscribes.push(() => ref.off('value', handler));
}

// ★ 버그2 수정 핵심: 게임 진행 중 업데이트만 처리하는 리스너 (매칭 화면 절대 안 띄움)
function listenGameRoom() {
  const ref = onlinePvp.roomRef;

  const handler = ref.on('value', snap => {
    const room = snap.val();
    if (!room) return;

    if (room.status === 'disconnected') {
      stopOnlineTimer();
      clearOnlineListeners();
      showOnlineResult('disconnect');
      return;
    }

    if (room.status === 'finished') {
      // handleRoomUpdate 에서도 처리하지만 여기서 한 번 더 보장
      handleRoomUpdate(room);
      return;
    }

    if (room.status === 'playing' && onlinePvp._gameStarted) {
      handleRoomUpdate(room);
    }
  });

  onlinePvp.unsubscribes.push(() => ref.off('value', handler));
}

// ─── 게임 시작 ────────────────────────────────────────────────────────────
function startOnlineGame(room) {
  onlinePvp.questions = room.questions;
  onlinePvp.currentQuestionIdx = 0;
  onlinePvp.myCorrect = 0;
  onlinePvp.oppCorrect = 0;

  // 상대방 정보
  const myKey   = onlinePvp.playerId;
  const oppKey  = myKey === 'player1' ? 'player2' : 'player1';
  onlinePvp.myInfo  = room[myKey];
  onlinePvp.oppInfo = room[oppKey];

  showScreen('onlineBattleScreen');
  updateOnlineBattleUI();
  showOnlineCountdown(() => loadOnlineQuestion(0));
}

function showOnlineCountdown(callback) {
  const el = document.getElementById('onlineCountdown');
  el.style.display = 'flex';
  let count = 3;
  el.querySelector('.countdown-number').textContent = count;

  const iv = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(iv);
      el.style.display = 'none';
      callback();
    } else {
      el.querySelector('.countdown-number').textContent = count;
    }
  }, 1000);
}

// ─── 문제 로드 ────────────────────────────────────────────────────────────
function loadOnlineQuestion(idx) {
  if (idx >= onlinePvp.questions.length) return;

  onlinePvp.currentQuestionIdx = idx;
  onlinePvp.answered = false;
  onlinePvp.hintUsed = false;

  const q = onlinePvp.questions[idx];

  document.getElementById('onlineQNum').textContent   = `문제 ${idx + 1} / ${ONLINE_TOTAL_Q}`;
  document.getElementById('onlineQTopic').textContent = q.topic;
  document.getElementById('onlineQText').textContent  = q.text;
  document.getElementById('onlineFeedback').textContent = '먼저 정답을 맞혀라! ⚡';
  document.getElementById('onlineFeedback').className  = 'online-feedback';

  // 선택지 / 입력창 렌더링
  renderOnlineAnswerUI(q);

  // 타이머 시작
  onlinePvp.questionStartTime = Date.now();
  startOnlineTimer();

  // Firebase: 내 답변 상태 초기화
  const update = {
    [`${onlinePvp.playerId}Answered`]: false,
    [`${onlinePvp.playerId}Time`]: null,
  };
  onlinePvp.roomRef.update(update);
}

function startOnlineTimer() {
  stopOnlineTimer();
  const limit = getTimeLimit(onlinePvp.character);
  onlinePvp.timerInterval = setInterval(() => {
    const elapsed   = (Date.now() - onlinePvp.questionStartTime) / 1000;
    const remaining = Math.max(0, limit - elapsed);
    document.getElementById('onlineTimer').textContent = remaining.toFixed(1);

    if (remaining <= 0) {
      stopOnlineTimer();
      if (!onlinePvp.answered) submitOnlineAnswer(false, limit);
    }
  }, 100);
}

// ─── 답변 렌더링 ──────────────────────────────────────────────────────────
function renderOnlineAnswerUI(q) {
  const wrap    = document.getElementById('onlineAnswerWrap');
  const inputEl = document.getElementById('onlineAnswerInput');
  wrap.querySelectorAll('.choice-btn').forEach(b => b.remove());

  if (q.choices && q.choices.length > 0) {
    inputEl.style.display = 'none';
    q.choices.forEach(ch => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = ch;
      btn.addEventListener('click', () => {
        inputEl.value = ch;
        handleOnlineAttack();
      });
      wrap.appendChild(btn);
    });
  } else {
    inputEl.style.display = '';
    inputEl.value = '';
    inputEl.focus();
  }
}

// ─── 공격 버튼 ────────────────────────────────────────────────────────────
function handleOnlineAttack() {
  if (onlinePvp.answered) return;
  const input = document.getElementById('onlineAnswerInput').value.trim();
  if (!input) return;

  const q       = onlinePvp.questions[onlinePvp.currentQuestionIdx];
  const correct = isCorrectAnswer(input, q.answer);
  const elapsed = (Date.now() - onlinePvp.questionStartTime) / 1000;

  submitOnlineAnswer(correct, elapsed);
}

async function submitOnlineAnswer(correct, elapsed) {
  if (onlinePvp.answered) return;
  onlinePvp.answered = true;
  stopOnlineTimer();

  const myKey = onlinePvp.playerId;

  if (correct) {
    onlinePvp.myCorrect++;
    document.getElementById('onlineFeedback').textContent = `✅ 정답! ${elapsed.toFixed(1)}초`;
    document.getElementById('onlineFeedback').className   = 'online-feedback correct';
  } else {
    document.getElementById('onlineFeedback').textContent = '❌ 오답...';
    document.getElementById('onlineFeedback').className   = 'online-feedback wrong';
  }

  updateOnlineBattleUI();

  // Firebase에 내 결과 기록
  await onlinePvp.roomRef.update({
    [`${myKey}Answered`]: true,
    [`${myKey}Correct`]:  correct,
    [`${myKey}Time`]:     elapsed,
    [`${myKey}Score`]:    onlinePvp.myCorrect,
  });

  // 승리 조건 체크 (내가 먼저 맞힌 경우)
  if (onlinePvp.myCorrect >= ONLINE_WIN_COUNT) {
    await onlinePvp.roomRef.update({ status: 'finished', winner: myKey });
  }
}

// ─── 방 업데이트 처리 ─────────────────────────────────────────────────────
function handleRoomUpdate(room) {
  const myKey  = onlinePvp.playerId;
  const oppKey = myKey === 'player1' ? 'player2' : 'player1';

  // 상대방 점수 동기화
  const oppScore = room[`${oppKey}Score`] || 0;
  if (oppScore !== onlinePvp.oppCorrect) {
    onlinePvp.oppCorrect = oppScore;
    updateOnlineBattleUI();
  }

  // 게임 종료 처리
  if (room.status === 'finished') {
    stopOnlineTimer();
    clearOnlineListeners();
    const iWin = room.winner === myKey;
    showOnlineResult(iWin ? 'win' : 'lose');
    return;
  }

  // 둘 다 답했으면 다음 문제로
  const myAnswered  = room[`${myKey}Answered`];
  const oppAnswered = room[`${oppKey}Answered`];

  if (myAnswered && oppAnswered && onlinePvp.answered) {
    const nextIdx = onlinePvp.currentQuestionIdx + 1;
    if (nextIdx < ONLINE_TOTAL_Q) {
      setTimeout(() => loadOnlineQuestion(nextIdx), 1500);
    }
    // 5문제 다 풀었는데 아무도 3개 못 맞힌 경우 → 더 많이 맞힌 사람 승리
    else if (nextIdx >= ONLINE_TOTAL_Q) {
      determineWinnerByScore(room);
    }
  }
}

async function determineWinnerByScore(room) {
  const myKey  = onlinePvp.playerId;
  const oppKey = myKey === 'player1' ? 'player2' : 'player1';

  if (onlinePvp.playerId === 'player1') {
    const myScore  = room[`${myKey}Score`] || 0;
    const oppScore = room[`${oppKey}Score`] || 0;
    let winner;
    if (myScore > oppScore) winner = myKey;
    else if (oppScore > myScore) winner = oppKey;
    else winner = 'draw';

    await onlinePvp.roomRef.update({ status: 'finished', winner });
  }
}

// ─── UI 업데이트 ──────────────────────────────────────────────────────────
function updateOnlineBattleUI() {
  const my  = onlinePvp.myInfo  || {};
  const opp = onlinePvp.oppInfo || {};

  document.getElementById('onlineMyEmoji').textContent   = onlinePvp.character?.emoji || '❓';
  document.getElementById('onlineMyNick').textContent    = onlinePvp.nickname;
  document.getElementById('onlineMyScore').textContent   = `${onlinePvp.myCorrect} / ${ONLINE_WIN_COUNT}`;

  document.getElementById('onlineOppEmoji').textContent  = opp.emoji || '❓';
  document.getElementById('onlineOppNick').textContent   = opp.nickname || '상대방';
  document.getElementById('onlineOppScore').textContent  = `${onlinePvp.oppCorrect} / ${ONLINE_WIN_COUNT}`;

  // 점수 바
  document.getElementById('onlineMyBar').style.width  = (onlinePvp.myCorrect  / ONLINE_WIN_COUNT * 100) + '%';
  document.getElementById('onlineOppBar').style.width = (onlinePvp.oppCorrect / ONLINE_WIN_COUNT * 100) + '%';
}

// ─── 힌트 ─────────────────────────────────────────────────────────────────
function useOnlineHint() {
  if (onlinePvp.hintUsed || onlinePvp.answered) return;
  onlinePvp.hintUsed = true;
  const q = onlinePvp.questions[onlinePvp.currentQuestionIdx];
  document.getElementById('onlineFeedback').textContent = `💡 ${q.hint || '문제를 다시 읽어보세요.'}`;
}

// ─── 랭킹 저장 ────────────────────────────────────────────────────────────
async function saveWinToRanking(nickname) {
  const safeKey = nickname.replace(/[.#$[\]/]/g, '_');
  const ref = db.ref(`rankings/${safeKey}`);
  try {
    const snap = await ref.once('value');
    const cur  = snap.val();
    if (cur) {
      await ref.update({ wins: (cur.wins || 0) + 1, lastWin: Date.now() });
    } else {
      await ref.set({ nickname, wins: 1, lastWin: Date.now() });
    }
  } catch(e) { console.warn('랭킹 저장 실패', e); }
}

// ─── 랭킹 불러오기 ────────────────────────────────────────────────────────
async function loadRanking() {
  const list = document.getElementById('rankingList');
  list.innerHTML = '<div class="rank-loading">불러오는 중...</div>';
  try {
    const snap = await db.ref('rankings').orderByChild('wins').limitToLast(10).once('value');
    const rows = [];
    snap.forEach(child => rows.push(child.val()));
    rows.sort((a, b) => b.wins - a.wins);

    if (rows.length === 0) {
      list.innerHTML = '<div class="rank-empty">아직 기록이 없어요! 첫 승리를 차지하세요 🏆</div>';
      return;
    }

    const medals = ['🥇','🥈','🥉'];
    list.innerHTML = rows.map((r, i) => `
      <div class="rank-row ${r.nickname === onlinePvp.nickname ? 'rank-me' : ''}">
        <span class="rank-num">${medals[i] || (i + 1)}</span>
        <span class="rank-nick">${r.nickname}</span>
        <span class="rank-wins">${r.wins}승</span>
      </div>`).join('');
  } catch(e) {
    list.innerHTML = '<div class="rank-empty">랭킹을 불러올 수 없어요.</div>';
  }
}

// ─── 결과 화면 ────────────────────────────────────────────────────────────
async function showOnlineResult(result) {
  // 승리면 랭킹 저장 먼저
  if (result === 'win') {
    await saveWinToRanking(onlinePvp.nickname);
  }

  showScreen('onlineResultScreen');

  // 결과 유형별 콘텐츠
  const configs = {
    win:        { emoji:'🏆', title:'승리!',    titleClass:'result-win',  sub: winMessage() },
    lose:       { emoji:'💀', title:'패배...',  titleClass:'result-lose', sub: `${onlinePvp.myCorrect}문제 정답. 다시 도전해봐!` },
    draw:       { emoji:'🤝', title:'무승부!',  titleClass:'result-draw', sub: `둘 다 ${onlinePvp.myCorrect}문제! 팽팽한 대결이었어요.` },
    disconnect: { emoji:'🔌', title:'연결 끊김', titleClass:'',           sub: '상대방 연결이 종료되었어요.' },
  };
  const cfg = configs[result] || configs.disconnect;

  document.getElementById('onlineResultEmoji').textContent    = cfg.emoji;
  document.getElementById('onlineResultTitle').textContent    = cfg.title;
  document.getElementById('onlineResultTitle').className      = `online-result-title ${cfg.titleClass}`;
  document.getElementById('onlineResultSub').textContent      = cfg.sub;
  document.getElementById('onlineResultMyScore').textContent  = onlinePvp.myCorrect;
  document.getElementById('onlineResultOppScore').textContent = onlinePvp.oppCorrect;
  document.getElementById('onlineResultMyNick').textContent   = onlinePvp.nickname;
  document.getElementById('onlineResultOppNick').textContent  = onlinePvp.oppInfo?.nickname || '상대방';

  // 승리 이펙트
  if (result === 'win') triggerWinEffect();

  // 랭킹 로드
  loadRanking();

  // 방 정리
  if (onlinePvp.roomRef) onlinePvp.roomRef.onDisconnect().cancel();
  onlinePvp._gameStarted = false;
}

// 승리 메시지 랜덤
function winMessage() {
  const msgs = [
    '🔥 압도적인 실력이에요!',
    '⚡ 번개처럼 빠른 풀이!',
    '🌟 완벽한 승리!',
    '👑 수학의 왕이 되었습니다!',
    '💥 상대를 완전히 제압했어요!',
    '🚀 로켓처럼 정확했어요!',
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

// 승리 파티클 이펙트
function triggerWinEffect() {
  const container = document.getElementById('winEffectContainer');
  if (!container) return;
  container.innerHTML = '';
  const emojis = ['🏆','⭐','🌟','✨','🎉','🎊','💫','🔥'];
  for (let i = 0; i < 22; i++) {
    const el = document.createElement('div');
    el.className = 'win-particle';
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.cssText = `
      left: ${Math.random() * 100}%;
      animation-delay: ${Math.random() * 0.8}s;
      animation-duration: ${1.2 + Math.random() * 1}s;
      font-size: ${18 + Math.random() * 18}px;
    `;
    container.appendChild(el);
  }
  setTimeout(() => { container.innerHTML = ''; }, 3000);
}

// ─── 문제 선택 ────────────────────────────────────────────────────────────
function pickOnlineQuestions() {
  const diff = gameState.difficulty || 'easy';
  let pool = PROBLEM_PACK.problems.filter(p => p.difficulty === diff);
  if (pool.length === 0) pool = PROBLEM_PACK.problems;

  // 셔플 후 5개 선택
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, ONLINE_TOTAL_Q);
}

// ─── 이벤트 바인딩 (DOMContentLoaded 이후 호출) ───────────────────────────
function initOnlinePvpEvents() {
  document.getElementById('onlineAttackBtn').addEventListener('click', handleOnlineAttack);
  document.getElementById('onlineHintBtn').addEventListener('click', useOnlineHint);
  document.getElementById('onlineQuitBtn').addEventListener('click', () => {
    if (confirm('대전을 포기하고 메인으로 돌아갈까요?')) {
      stopOnlineTimer();
      clearOnlineListeners();
      if (onlinePvp.roomRef) onlinePvp.roomRef.update({ status: 'disconnected' });
      onlinePvp._gameStarted = false;
      location.reload();
    }
  });
  document.getElementById('onlineResultRematch').addEventListener('click', () => {
    onlinePvp._gameStarted = false;
    showOnlineLobby();
  });
  document.getElementById('onlineResultHome').addEventListener('click', () => location.reload());
  document.getElementById('rankingRefreshBtn').addEventListener('click', loadRanking);
  document.getElementById('cancelMatchBtn').addEventListener('click', async () => {
    if (onlinePvp.roomId) {
      const diff = gameState.difficulty || 'easy';
      await db.ref(`waiting_${diff}/${onlinePvp.roomId}`).remove();
      await onlinePvp.roomRef?.remove();
    }
    clearOnlineListeners();
    location.reload();
  });
  document.getElementById('lobbyNickname').addEventListener('keydown', e => {
    if (e.key === 'Enter') checkLobbyReady();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('onlineBattleScreen').classList.contains('active'))
      handleOnlineAttack();
  });
}
