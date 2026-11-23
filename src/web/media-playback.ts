const previews = new Set<HTMLMediaElement>();
export function registerMediaPreview(media: HTMLMediaElement) {
  previews.add(media);
  const play = () => pauseMediaPreviews(media);
  media.addEventListener('play', play);
  return () => {
    media.pause();
    media.removeEventListener('play', play);
    previews.delete(media);
    media.removeAttribute('src');
    media.load();
  };
}
export function pauseMediaPreviews(except?: HTMLMediaElement) {
  for (const media of previews) if (media !== except) media.pause();
}
