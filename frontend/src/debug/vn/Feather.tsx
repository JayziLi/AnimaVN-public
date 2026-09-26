/** 羽毛:加载、思考中、生成中都用它。颜色跟 currentColor,动画由外面的类名决定 */
export function Feather({ className = '', size = 18 }: { className?: string; size?: number }) {
  return (
    <svg
      className={`vn-feather ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M20.6 3.2c-5.8.4-10.6 3.9-12.9 9.2l-1.2 2.9 2.1.1-1 2.3c5.1-.5 9.2-3.8 11.1-8.4l-2.4-.2 3-1.5c.7-1.4 1.1-2.9 1.3-4.4z"
      />
      <path
        d="M3.6 20.8 14.8 9.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
