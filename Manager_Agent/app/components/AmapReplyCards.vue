<script setup lang="ts">
import { computed, ref, watch } from 'vue'

type AmapRouteStep = { text: string; kind?: string }
type AmapPlaceItem = { name: string; address?: string; distance_m?: number; map_url?: string | null }
type AmapRouteOption = {
  mode?: string
  mode_label?: string
  duration_minutes?: number
  distance_km?: number
  steps?: AmapRouteStep[]
  map_url?: string | null
  unavailable?: boolean
  hint?: string
}

export type UiCard =
  | {
      type: 'amap_route'
      title?: string
      origin?: string
      destination?: string
      mode_label?: string
      duration_minutes?: number
      distance_km?: number
      steps?: AmapRouteStep[]
      map_url?: string | null
      map_image_url?: string | null
    }
  | {
      type: 'amap_route_compare'
      title?: string
      origin?: string
      destination?: string
      recommended_mode?: string
      options?: AmapRouteOption[]
      map_image_url?: string | null
    }
  | {
      type: 'amap_places'
      title?: string
      subtitle?: string
      places?: AmapPlaceItem[]
      map_image_url?: string | null
    }
  | {
      type: 'amap_address'
      title?: string
      address?: string
      location?: string
      map_url?: string | null
      map_image_url?: string | null
    }

const props = defineProps<{ cards: UiCard[] }>()

const ROUTE_STEP_PREVIEW = 4

const visibleCards = computed(() =>
  (props.cards || []).filter((c) =>
    ['amap_route', 'amap_route_compare', 'amap_places', 'amap_address'].includes(String(c?.type || ''))
  )
)

function stepIcon(kind?: string) {
  switch (kind) {
    case 'walk':
      return '🚶'
    case 'transit':
      return '🚇'
    case 'bike':
      return '🚲'
    case 'drive':
      return '🚗'
    default:
      return '•'
  }
}

function modeTabIcon(mode?: string) {
  switch (String(mode || '').toLowerCase()) {
    case 'driving':
    case 'drive':
      return '🚗'
    case 'transit':
    case 'bus':
    case 'subway':
      return '🚇'
    case 'walk':
    case 'walking':
      return '🚶'
    case 'bike':
    case 'bicycling':
      return '🚲'
    default:
      return '📍'
  }
}

function resolveMapImageSrc(path?: string | null): string | null {
  const raw = String(path || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw
  return raw.startsWith('/') ? raw : `/${raw}`
}

function createCompareState(card: Extract<UiCard, { type: 'amap_route_compare' }>) {
  const options = card.options ?? []
  const defaultMode =
    card.recommended_mode ||
    options.find((o) => !o.unavailable && o.duration_minutes != null)?.mode ||
    options.find((o) => !o.unavailable)?.mode ||
    options[0]?.mode ||
    ''
  const activeMode = ref(defaultMode)
  const active = computed(
    () => options.find((o) => o.mode === activeMode.value) ?? options[0] ?? null
  )
  const stepsExpanded = ref(false)
  const steps = computed(() => active.value?.steps ?? [])
  const visibleSteps = computed(() =>
    stepsExpanded.value ? steps.value : steps.value.slice(0, ROUTE_STEP_PREVIEW)
  )
  const hiddenStepCount = computed(() => Math.max(0, steps.value.length - ROUTE_STEP_PREVIEW))
  return { options, activeMode, active, stepsExpanded, steps, visibleSteps, hiddenStepCount }
}

type CompareState = ReturnType<typeof createCompareState>
const compareStates = ref<Record<number, CompareState>>({})

watch(
  () => props.cards,
  (cards) => {
    const next: Record<number, CompareState> = {}
    ;(cards || []).forEach((c, i) => {
      if (c.type === 'amap_route_compare') {
        next[i] = createCompareState(c)
      }
    })
    compareStates.value = next
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="visibleCards.length" class="amap-reply-cards">
    <template v-for="(card, ci) in visibleCards" :key="ci">
      <article v-if="card.type === 'amap_route'" class="amap-card amap-card--route">
        <header class="amap-card__head">
          <div class="amap-card__title-row">
            <span class="amap-card__badge">高德</span>
            <h4 class="amap-card__title">{{ card.title || '出行路线' }}</h4>
          </div>
          <p class="amap-card__route-endpoints">
            <span>{{ card.origin || '起点' }}</span>
            <span class="amap-card__arrow" aria-hidden="true">→</span>
            <span>{{ card.destination || '终点' }}</span>
          </p>
        </header>
        <div v-if="resolveMapImageSrc(card.map_image_url)" class="amap-map-preview">
          <img
            class="amap-map-preview__img"
            :src="resolveMapImageSrc(card.map_image_url)!"
            :alt="`${card.origin || '起点'} 到 ${card.destination || '终点'} 路线预览`"
            loading="lazy"
          />
        </div>
        <div class="amap-card__stats">
          <span v-if="card.duration_minutes != null" class="amap-stat-pill">
            <span class="amap-stat-pill__label">预计</span>
            <span class="amap-stat-pill__value">{{ card.duration_minutes }} 分钟</span>
          </span>
          <span v-if="card.distance_km != null" class="amap-stat-pill">
            <span class="amap-stat-pill__label">距离</span>
            <span class="amap-stat-pill__value">{{ card.distance_km }} 公里</span>
          </span>
          <span v-if="card.mode_label" class="amap-stat-pill">
            <span class="amap-stat-pill__label">方式</span>
            <span class="amap-stat-pill__value">{{ card.mode_label }}</span>
          </span>
        </div>
        <ol v-if="card.steps?.length" class="amap-route-steps">
          <li v-for="(step, si) in card.steps" :key="si" class="amap-route-step">
            <span class="amap-route-step__icon" aria-hidden="true">{{ stepIcon(step.kind) }}</span>
            <span class="amap-route-step__text">{{ step.text }}</span>
          </li>
        </ol>
        <footer v-if="card.map_url" class="amap-card__foot">
          <a class="amap-map-link" :href="card.map_url" target="_blank" rel="noopener noreferrer">在高德地图中打开导航 →</a>
          <span class="amap-card__hint">数据来自高德 Web 服务 · 个人开发者有日免费额度</span>
        </footer>
      </article>

      <article
        v-else-if="card.type === 'amap_route_compare' && compareStates[ci]"
        class="amap-card amap-card--route amap-card--compare"
      >
        <header class="amap-card__head">
          <div class="amap-card__title-row">
            <span class="amap-card__badge">高德</span>
            <h4 class="amap-card__title">{{ card.title || '出行方案对比' }}</h4>
          </div>
          <p class="amap-card__route-endpoints">
            <span>{{ card.origin || '起点' }}</span>
            <span class="amap-card__arrow" aria-hidden="true">→</span>
            <span>{{ card.destination || '终点' }}</span>
          </p>
        </header>
        <div v-if="resolveMapImageSrc(card.map_image_url)" class="amap-map-preview">
          <img
            class="amap-map-preview__img"
            :src="resolveMapImageSrc(card.map_image_url)!"
            :alt="`${card.origin || '起点'} 到 ${card.destination || '终点'} 路线预览`"
            loading="lazy"
          />
        </div>
        <div class="amap-compare-tabs" role="tablist" aria-label="出行方式对比">
          <button
            v-for="opt in compareStates[ci]!.options"
            :key="opt.mode || opt.mode_label"
            type="button"
            role="tab"
            :aria-selected="opt.mode === compareStates[ci]!.activeMode"
            :class="[
              'amap-compare-tab',
              opt.mode === compareStates[ci]!.activeMode ? 'is-active' : '',
              opt.unavailable ? 'is-unavailable' : '',
            ]"
            @click="opt.mode && (compareStates[ci]!.activeMode = opt.mode)"
          >
            <span class="amap-compare-tab__icon" aria-hidden="true">{{ modeTabIcon(opt.mode) }}</span>
            <span class="amap-compare-tab__label">{{ opt.mode_label || opt.mode || '方案' }}</span>
            <span class="amap-compare-tab__meta">
              {{
                opt.unavailable
                  ? '暂无方案'
                  : `${opt.duration_minutes != null ? `${opt.duration_minutes} 分钟` : '—'}${opt.distance_km != null ? ` · ${opt.distance_km} 公里` : ''}`
              }}
            </span>
            <span
              v-if="!opt.unavailable && opt.mode === card.recommended_mode"
              class="amap-compare-tab__badge"
            >最快</span>
          </button>
        </div>
        <template v-if="compareStates[ci]!.active">
          <p
            v-if="compareStates[ci]!.active!.unavailable"
            class="amap-compare-unavailable"
          >{{ compareStates[ci]!.active!.hint || '该出行方式暂无可用路线' }}</p>
          <template v-else>
            <div class="amap-card__stats">
              <span v-if="compareStates[ci]!.active!.duration_minutes != null" class="amap-stat-pill">
                <span class="amap-stat-pill__label">预计</span>
                <span class="amap-stat-pill__value">{{ compareStates[ci]!.active!.duration_minutes }} 分钟</span>
              </span>
              <span v-if="compareStates[ci]!.active!.distance_km != null" class="amap-stat-pill">
                <span class="amap-stat-pill__label">距离</span>
                <span class="amap-stat-pill__value">{{ compareStates[ci]!.active!.distance_km }} 公里</span>
              </span>
              <span v-if="compareStates[ci]!.active!.mode_label" class="amap-stat-pill">
                <span class="amap-stat-pill__label">方式</span>
                <span class="amap-stat-pill__value">{{ compareStates[ci]!.active!.mode_label }}</span>
              </span>
            </div>
            <ol v-if="compareStates[ci]!.steps.length" class="amap-route-steps">
              <li
                v-for="(step, si) in compareStates[ci]!.visibleSteps"
                :key="si"
                class="amap-route-step"
              >
                <span class="amap-route-step__icon" aria-hidden="true">{{ stepIcon(step.kind) }}</span>
                <span class="amap-route-step__text">{{ step.text }}</span>
              </li>
            </ol>
            <button
              v-if="compareStates[ci]!.hiddenStepCount > 0"
              type="button"
              class="amap-steps-toggle"
              @click="compareStates[ci]!.stepsExpanded = !compareStates[ci]!.stepsExpanded"
            >
              {{
                compareStates[ci]!.stepsExpanded
                  ? '收起步骤'
                  : `展开全部 ${compareStates[ci]!.steps.length} 步（还有 ${compareStates[ci]!.hiddenStepCount} 步）`
              }}
            </button>
          </template>
        </template>
        <footer class="amap-card__foot">
          <a
            v-if="compareStates[ci]!.active && !compareStates[ci]!.active!.unavailable && compareStates[ci]!.active!.map_url"
            class="amap-map-link"
            :href="compareStates[ci]!.active!.map_url!"
            target="_blank"
            rel="noopener noreferrer"
          >在高德地图中打开导航 →</a>
          <span class="amap-card__hint">已对比驾车 / 公交地铁 / 步行 · 数据来自高德 Web 服务</span>
        </footer>
      </article>

      <article v-else-if="card.type === 'amap_places'" class="amap-card amap-card--places">
        <header class="amap-card__head">
          <div class="amap-card__title-row">
            <span class="amap-card__badge">高德</span>
            <h4 class="amap-card__title">{{ card.title || '地点' }}</h4>
          </div>
          <p v-if="card.subtitle" class="amap-card__subtitle">{{ card.subtitle }}</p>
        </header>
        <div v-if="resolveMapImageSrc(card.map_image_url)" class="amap-map-preview">
          <img
            class="amap-map-preview__img"
            :src="resolveMapImageSrc(card.map_image_url)!"
            :alt="card.title || '地点分布预览'"
            loading="lazy"
          />
        </div>
        <ul class="amap-place-list">
          <li v-for="(place, pi) in card.places || []" :key="pi" class="amap-place-item">
            <div class="amap-place-item__main">
              <span class="amap-place-item__index">{{ pi + 1 }}</span>
              <div class="amap-place-item__body">
                <div class="amap-place-item__name">{{ place.name }}</div>
                <div v-if="place.address" class="amap-place-item__addr">{{ place.address }}</div>
              </div>
              <span v-if="place.distance_m != null" class="amap-place-item__dist">{{ place.distance_m }}m</span>
            </div>
            <a
              v-if="place.map_url"
              class="amap-place-item__link"
              :href="place.map_url"
              target="_blank"
              rel="noopener noreferrer"
            >查看地图</a>
          </li>
        </ul>
      </article>

      <article v-else-if="card.type === 'amap_address'" class="amap-card amap-card--address">
        <header class="amap-card__head">
          <div class="amap-card__title-row">
            <span class="amap-card__badge">高德</span>
            <h4 class="amap-card__title">{{ card.title || '地址' }}</h4>
          </div>
        </header>
        <div v-if="resolveMapImageSrc(card.map_image_url)" class="amap-map-preview">
          <img
            class="amap-map-preview__img"
            :src="resolveMapImageSrc(card.map_image_url)!"
            :alt="card.address || '地址位置预览'"
            loading="lazy"
          />
        </div>
        <p class="amap-address-text">{{ card.address || '—' }}</p>
        <p v-if="card.location" class="amap-address-coord">坐标 {{ card.location }}</p>
        <footer v-if="card.map_url" class="amap-card__foot">
          <a class="amap-map-link" :href="card.map_url" target="_blank" rel="noopener noreferrer">在高德地图中查看 →</a>
        </footer>
      </article>
    </template>
  </div>
</template>
