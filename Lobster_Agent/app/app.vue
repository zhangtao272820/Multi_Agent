<template>
  <ClientOnly>
    <ClawhiveLoginGate v-if="needAuth && authReady && !isLoggedIn" @success="onLoginOk" />
  </ClientOnly>
  <div v-if="!needAuth || (authReady && isLoggedIn)" class="snow-scene">
    <div class="moon-system" aria-hidden="true">
      <div class="moon-halo" />
      <div class="moon-disc">
        <span class="crater crater-1" />
        <span class="crater crater-2" />
        <span class="crater crater-3" />
        <span class="crater crater-4" />
      </div>
      <div class="moon-glare" />
      <div class="moonlight-beam" />
      <div class="moonlight-haze" />
    </div>
    <div class="snow-layer snow-layer-back" aria-hidden="true">
      <span
        v-for="flake in backFlakes"
        :key="`b-${flake.id}`"
        class="snowflake"
        :style="flake.style"
      />
    </div>
    <div class="snow-layer snow-layer-mid" aria-hidden="true">
      <span
        v-for="flake in midFlakes"
        :key="`m-${flake.id}`"
        class="snowflake"
        :style="flake.style"
      />
    </div>
    <div class="snow-layer snow-layer-front" aria-hidden="true">
      <span
        v-for="flake in frontFlakes"
        :key="`f-${flake.id}`"
        class="snowflake"
        :style="flake.style"
      />
    </div>
    <div class="scene-overlay" aria-hidden="true" />
    <NuxtPage />
  </div>
</template>

<script setup lang="ts">
const runtimeConfig = useRuntimeConfig()
const needAuth = computed(() => String(runtimeConfig.public?.agentBrowserAuth ?? '1') !== '0')
const { isLoggedIn, ready: authReady, loadFromStorage } = useClawhiveLogin()
function onLoginOk() {
  loadFromStorage()
}
onMounted(() => loadFromStorage())

type FlakeItem = {
  id: number
  style: Record<string, string>
}

function buildFlakes(count: number, sizeRange: [number, number], durationRange: [number, number], driftRange: [number, number], opacityRange: [number, number]): FlakeItem[] {
  const [sizeMin, sizeMax] = sizeRange
  const [durMin, durMax] = durationRange
  const [driftMin, driftMax] = driftRange
  const [opMin, opMax] = opacityRange
  const out: FlakeItem[] = []

  for (let i = 0; i < count; i++) {
    const size = sizeMin + Math.random() * (sizeMax - sizeMin)
    const left = Math.random() * 100
    const delay = -Math.random() * durMax
    const duration = durMin + Math.random() * (durMax - durMin)
    const drift = driftMin + Math.random() * (driftMax - driftMin)
    const opacity = opMin + Math.random() * (opMax - opMin)
    out.push({
      id: i,
      style: {
        '--size': `${size.toFixed(2)}px`,
        '--left': `${left.toFixed(2)}vw`,
        '--delay': `${delay.toFixed(2)}s`,
        '--duration': `${duration.toFixed(2)}s`,
        '--drift': `${drift.toFixed(2)}px`,
        '--opacity': opacity.toFixed(3)
      }
    })
  }
  return out
}

// 雪花用 Math.random，必须在客户端生成，避免 SSR/CSR hydration mismatch
const backFlakes = ref<FlakeItem[]>([])
const midFlakes = ref<FlakeItem[]>([])
const frontFlakes = ref<FlakeItem[]>([])

onMounted(() => {
  backFlakes.value = buildFlakes(56, [4, 8], [26, 44], [10, 24], [0.2, 0.46])
  midFlakes.value = buildFlakes(42, [6, 12], [22, 36], [14, 30], [0.28, 0.62])
  frontFlakes.value = buildFlakes(32, [10, 20], [20, 34], [20, 42], [0.5, 0.9])
})
</script>

<style>
:root {
  color-scheme: dark;
}

html,
body,
#__nuxt {
  margin: 0;
  min-height: 100%;
  background: #060a14;
}

.snow-scene {
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  background:
    radial-gradient(900px 580px at 78% -8%, rgba(243, 249, 255, 0.24), rgba(195, 226, 255, 0.14) 33%, rgba(110, 148, 213, 0.05) 56%, transparent 74%),
    radial-gradient(1050px 680px at 72% 18%, rgba(181, 215, 255, 0.12), transparent 63%),
    radial-gradient(1200px 700px at 10% 5%, rgba(126, 169, 255, 0.22), transparent 62%),
    radial-gradient(1000px 700px at 85% 24%, rgba(169, 221, 255, 0.18), transparent 60%),
    radial-gradient(900px 600px at 50% 100%, rgba(188, 140, 255, 0.12), transparent 55%),
    linear-gradient(180deg, #081022 0%, #0b1329 48%, #070d1d 100%);
}

.moon-system {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}

.moon-halo {
  position: absolute;
  top: 4vh;
  right: 7.2vw;
  width: clamp(260px, 32vw, 520px);
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle at 52% 52%, rgba(246, 252, 255, 0.14) 0 24%, rgba(196, 224, 255, 0.08) 42%, rgba(133, 173, 232, 0.04) 62%, transparent 78%);
  filter: blur(1px);
}

.moon-disc {
  position: absolute;
  top: clamp(24px, 4.6vh, 74px);
  right: clamp(26px, 6.8vw, 150px);
  width: clamp(98px, 11.2vw, 178px);
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle at 35% 28%, rgba(255, 255, 255, 0.95) 0 18%, rgba(245, 251, 255, 0.9) 26%, rgba(226, 238, 251, 0.86) 55%, rgba(193, 211, 235, 0.82) 76%, rgba(148, 170, 198, 0.82) 100%);
  box-shadow:
    0 0 18px rgba(214, 234, 255, 0.82),
    0 0 52px rgba(174, 210, 255, 0.45),
    0 0 110px rgba(130, 176, 236, 0.28),
    inset -10px -14px 24px rgba(88, 112, 144, 0.26),
    inset 8px 10px 16px rgba(255, 255, 255, 0.34);
}

.moon-disc .crater {
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, rgba(128, 151, 182, 0.5), rgba(188, 208, 232, 0.08) 72%, transparent 100%);
  box-shadow: inset 0 1px 3px rgba(78, 96, 122, 0.2);
}

.moon-disc .crater-1 {
  width: 16%;
  aspect-ratio: 1;
  top: 28%;
  left: 24%;
}

.moon-disc .crater-2 {
  width: 12%;
  aspect-ratio: 1;
  top: 44%;
  right: 26%;
}

.moon-disc .crater-3 {
  width: 9%;
  aspect-ratio: 1;
  top: 18%;
  right: 38%;
}

.moon-disc .crater-4 {
  width: 14%;
  aspect-ratio: 1;
  bottom: 24%;
  left: 39%;
}

.moon-glare {
  position: absolute;
  top: clamp(36px, 6vh, 90px);
  right: clamp(38px, 8.6vw, 188px);
  width: clamp(210px, 24vw, 410px);
  height: clamp(120px, 16vh, 230px);
  background: radial-gradient(ellipse at 50% 10%, rgba(224, 240, 255, 0.38), rgba(169, 209, 255, 0.15) 52%, transparent 78%);
  filter: blur(12px);
}

.moonlight-beam {
  position: absolute;
  top: clamp(88px, 13vh, 186px);
  right: clamp(-300px, -10vw, -120px);
  width: clamp(620px, 66vw, 980px);
  height: clamp(520px, 66vh, 820px);
  transform: rotate(-14deg);
  transform-origin: top right;
  background:
    conic-gradient(from 192deg at 74% 0%, rgba(218, 236, 255, 0.16) 0deg 18deg, rgba(168, 204, 248, 0.08) 18deg 35deg, rgba(88, 126, 190, 0.02) 35deg 58deg, transparent 58deg 360deg);
  filter: blur(2px);
  opacity: 0.92;
}

.moonlight-haze {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(1200px 680px at 76% 10%, rgba(176, 212, 255, 0.09), transparent 66%),
    linear-gradient(163deg, rgba(100, 138, 198, 0.08) 18%, rgba(72, 108, 170, 0.04) 34%, transparent 58%);
}

.scene-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  background:
    radial-gradient(800px 450px at 50% 10%, rgba(255, 255, 255, 0.08), transparent 70%),
    linear-gradient(180deg, rgba(4, 8, 18, 0.2), rgba(4, 8, 18, 0.56));
}

.snow-layer {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.snow-layer-back {
  z-index: 0;
}

.snow-layer-front {
  z-index: 2;
}

.snow-layer-mid {
  z-index: 1;
}

.snow-layer-back .snowflake {
  filter: blur(0.2px) drop-shadow(0 0 4px rgba(210, 234, 255, 0.36));
}

.snow-layer-mid .snowflake {
  filter: drop-shadow(0 0 6px rgba(210, 234, 255, 0.55));
}

.snow-layer-front .snowflake {
  filter: drop-shadow(0 0 10px rgba(210, 234, 255, 0.72));
}

.snowflake {
  --size: 4px;
  --left: 50vw;
  --delay: 0s;
  --duration: 16s;
  --drift: 20px;
  --opacity: 0.7;
  position: absolute;
  top: -10vh;
  left: var(--left);
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  opacity: var(--opacity);
  background:
    radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.98) 0 27%, rgba(224, 240, 255, 0.82) 42%, rgba(224, 240, 255, 0.12) 74%, rgba(224, 240, 255, 0) 100%),
    conic-gradient(
      from 0deg,
      rgba(255, 255, 255, 0.95) 0deg 12deg,
      rgba(255, 255, 255, 0) 12deg 30deg,
      rgba(255, 255, 255, 0.88) 30deg 42deg,
      rgba(255, 255, 255, 0) 42deg 60deg,
      rgba(255, 255, 255, 0.95) 60deg 72deg,
      rgba(255, 255, 255, 0) 72deg 90deg,
      rgba(255, 255, 255, 0.88) 90deg 102deg,
      rgba(255, 255, 255, 0) 102deg 120deg,
      rgba(255, 255, 255, 0.95) 120deg 132deg,
      rgba(255, 255, 255, 0) 132deg 150deg,
      rgba(255, 255, 255, 0.88) 150deg 162deg,
      rgba(255, 255, 255, 0) 162deg 180deg,
      rgba(255, 255, 255, 0.95) 180deg 192deg,
      rgba(255, 255, 255, 0) 192deg 210deg,
      rgba(255, 255, 255, 0.88) 210deg 222deg,
      rgba(255, 255, 255, 0) 222deg 240deg,
      rgba(255, 255, 255, 0.95) 240deg 252deg,
      rgba(255, 255, 255, 0) 252deg 270deg,
      rgba(255, 255, 255, 0.88) 270deg 282deg,
      rgba(255, 255, 255, 0) 282deg 300deg,
      rgba(255, 255, 255, 0.95) 300deg 312deg,
      rgba(255, 255, 255, 0) 312deg 330deg,
      rgba(255, 255, 255, 0.88) 330deg 342deg,
      rgba(255, 255, 255, 0) 342deg 360deg
    );
  box-shadow:
    0 0 12px rgba(199, 227, 255, 0.66),
    0 0 28px rgba(203, 228, 255, 0.3);
  animation: snow-fall var(--duration) linear infinite;
  animation-delay: var(--delay);
}

@keyframes snow-fall {
  0% {
    transform: translate3d(0, -10vh, 0);
  }
  25% {
    transform: translate3d(calc(var(--drift) * -0.35), 25vh, 0);
  }
  55% {
    transform: translate3d(var(--drift), 55vh, 0);
  }
  80% {
    transform: translate3d(calc(var(--drift) * -0.3), 80vh, 0);
  }
  100% {
    transform: translate3d(calc(var(--drift) * 0.5), 115vh, 0);
  }
}

@media (max-width: 980px) {
  .moon-disc {
    width: clamp(80px, 16vw, 124px);
    right: clamp(18px, 5vw, 56px);
    top: clamp(18px, 4vh, 54px);
  }

  .moon-halo {
    right: 2vw;
    top: 2vh;
    width: clamp(200px, 48vw, 360px);
  }

  .moonlight-beam {
    width: clamp(420px, 86vw, 720px);
    height: clamp(420px, 74vh, 660px);
    right: clamp(-260px, -24vw, -96px);
    top: clamp(74px, 12vh, 152px);
  }
}
</style>
