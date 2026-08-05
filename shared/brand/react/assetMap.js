import platformLogo from '../logos/platform.svg?url'
import managerLogo from '../logos/manager.svg?url'
import dbLogo from '../logos/db.svg?url'
import ragLogo from '../logos/rag.svg?url'
import codeLogo from '../logos/code.svg?url'
import extractorLogo from '../logos/extractor.svg?url'
import adminLogo from '../logos/admin.svg?url'
import multimodalLogo from '../logos/multimodal.svg?url'
import musicLogo from '../logos/music.svg?url'
import videoLogo from '../logos/video.svg?url'
import lobsterLogo from '../logos/lobster.svg?url'

import platformAvatar from '../avatars/platform.svg?url'
import managerAvatar from '../avatars/manager.svg?url'
import dbAvatar from '../avatars/db.svg?url'
import ragAvatar from '../avatars/rag.svg?url'
import codeAvatar from '../avatars/code.svg?url'
import extractorAvatar from '../avatars/extractor.svg?url'
import adminAvatar from '../avatars/admin.svg?url'
import multimodalAvatar from '../avatars/multimodal.svg?url'
import musicAvatar from '../avatars/music.svg?url'
import videoAvatar from '../avatars/video.svg?url'
import lobsterAvatar from '../avatars/lobster.svg?url'

import { resolveBrandKey } from '../manifest.js'

export const BRAND_LOGOS = {
  platform: platformLogo,
  manager: managerLogo,
  db: dbLogo,
  rag: ragLogo,
  code: codeLogo,
  extractor: extractorLogo,
  admin: adminLogo,
  multimodal: multimodalLogo,
  music: musicLogo,
  video: videoLogo,
  lobster: lobsterLogo,
}

export const BRAND_AVATARS = {
  platform: platformAvatar,
  manager: managerAvatar,
  db: dbAvatar,
  rag: ragAvatar,
  code: codeAvatar,
  extractor: extractorAvatar,
  admin: adminAvatar,
  multimodal: multimodalAvatar,
  music: musicAvatar,
  video: videoAvatar,
  lobster: lobsterAvatar,
}

export function brandLogoUrl(nameOrKey) {
  const key = resolveBrandKey(nameOrKey)
  return BRAND_LOGOS[key] || ''
}

export function brandAvatarUrl(nameOrKey) {
  const key = resolveBrandKey(nameOrKey)
  return BRAND_AVATARS[key] || ''
}
