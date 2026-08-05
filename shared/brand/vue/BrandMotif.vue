<template>
  <div class="brand-motif brand-motif--fixed" aria-hidden="true">
    <template v-if="motif === 'moon'">
      <div class="brand-motif-moon__glow" />
      <div class="brand-motif-moon__disc" />
      <div class="brand-motif-moon__beam" />
    </template>

    <template v-else-if="motif === 'rain'">
      <div class="brand-motif-rain__sheet" />
      <span
        v-for="d in rainDrops"
        :key="d.key"
        class="brand-motif-rain__drop"
        :style="d.style"
      />
    </template>

    <template v-else-if="motif === 'snow'">
      <span
        v-for="f in snowFlakes"
        :key="f.key"
        class="brand-motif-snow__flake"
        :style="f.style"
      />
    </template>

    <template v-else-if="motif === 'thunder'">
      <div class="brand-motif-thunder__pulse" />
      <div class="brand-motif-thunder__vein" />
      <div
        class="brand-motif-thunder__bolt"
        style="--bolt-left: 68%; --bolt-top: 6%; --bolt-delay: 0s; --bolt-cycle: 12s"
      />
      <div
        class="brand-motif-thunder__bolt"
        style="--bolt-left: 22%; --bolt-top: 10%; --bolt-delay: 4.5s; --bolt-cycle: 14s; --bolt-len: 60px"
      />
    </template>

    <template v-else-if="motif === 'leaves'">
      <div class="brand-motif-leaves__haze" />
      <span
        v-for="l in leaves"
        :key="l.key"
        class="brand-motif-leaves__leaf"
        :style="l.style"
      />
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { buildRainDrops, buildSnowFlakes, buildFallingLeaves } from '../motifBuilders.js'

const props = defineProps({
  motif: {
    type: String,
    required: true,
    validator: (v) => ['rain', 'snow', 'moon', 'thunder', 'leaves'].includes(v),
  },
  /** 雨/雪/叶数量；不传则用默认密度 */
  count: {
    type: Number,
    default: undefined,
  },
})

const rainDrops = computed(() => buildRainDrops(props.count ?? 52))
const snowFlakes = computed(() => buildSnowFlakes(props.count ?? 46))
const leaves = computed(() => buildFallingLeaves(props.count ?? 28))
</script>
