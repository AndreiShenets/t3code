import icon from "../../../../assets/as-code/icon.svg";

export function AsCodeMark({ className }: { readonly className?: string }) {
  return <img src={icon} alt="" className={className} />;
}
