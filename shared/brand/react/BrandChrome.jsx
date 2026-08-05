import { getBrand } from '../manifest.js'
import BrandMotif from './BrandMotif.jsx'

/**
 * 顶栏品牌条：logo + 星曜标题 + 机甲占位头像 + 点缀层
 * @param {{
 *   agentKey: string,
 *   logoUrl: string,
 *   avatarUrl: string,
 *   subtitle?: string,
 *   showMotif?: boolean,
 *   right?: import('react').ReactNode,
 *   children?: import('react').ReactNode,
 * }} props
 */
export default function BrandChrome({
  agentKey,
  logoUrl,
  avatarUrl,
  subtitle,
  showMotif = true,
  right,
  children,
}) {
  const brand = getBrand(agentKey)
  if (!brand) return children || null

  return (
    <div className="brand-shell" data-agent={brand.key}>
      {showMotif ? <BrandMotif motif={brand.motif} /> : null}
      <header className="brand-topbar">
        <div className="brand-topbar__mark">
          {logoUrl ? <img className="brand-topbar__logo" src={logoUrl} alt="" width={36} height={36} /> : null}
          <div className="brand-topbar__titles">
            <p className="brand-topbar__eyebrow">ClawHive · {brand.en}</p>
            <h1 className="brand-topbar__title">{brand.cn}</h1>
            <p className="brand-topbar__sub">{subtitle || brand.role}</p>
          </div>
        </div>
        <div className="brand-topbar__spacer" />
        {right}
        {avatarUrl ? (
          <img className="brand-topbar__avatar" src={avatarUrl} alt="" width={48} height={48} title={`${brand.cn} 虚拟形象`} />
        ) : null}
      </header>
      {children}
    </div>
  )
}
