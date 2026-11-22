import { PRODUCT_NAME } from '@app/lib/constants/product';
import ProductMark from '@icon/macro-logo.svg';

/**
 * The product's wordmark: its mark beside its name. `textLength` holds the
 * name to the width the layout reserves for it, whichever font draws it.
 */
export default function MacroLogo(props: { class?: string }) {
  return (
    <svg
      viewBox="0 0 124 26"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={PRODUCT_NAME}
      fill="currentColor"
      class={props.class}
    >
      <ProductMark x="-3" y="1" width="24" height="24" aria-hidden="true" />
      <text
        x="25"
        y="21"
        font-size="22"
        font-weight="700"
        textLength="98"
        lengthAdjust="spacingAndGlyphs"
        aria-hidden="true"
      >
        {PRODUCT_NAME}
      </text>
    </svg>
  );
}
