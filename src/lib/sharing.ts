export function instagramCaption(productCount: number, labels: string[] = []) {
  const purchase = productCount === 1 ? "my new purchase" : "my new purchases";
  const names = labels.map((s) => s.trim()).filter(Boolean);
  return `✨ Celebrating Diwali with SKY Mobile & Electronics! 🪔\n\nMy smile, ${purchase}, and a little Diwali magic.${names.length ? `\nMy SKY picks: ${names.join(", ")}.` : ""}\n\nThank you @skymobileindia for making this festive season special!\n\n#DiwaliWithSKY #SKYMobile #SKYMobileElectronics #HappyDiwali #DiwaliShopping`;
}
export function copyCaption(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return Promise.resolve(false);
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}
