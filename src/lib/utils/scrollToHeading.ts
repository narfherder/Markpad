/** Distance kept between the container's top edge and the element jumped to. */
export const JUMP_OFFSET = 60;

/**
 * Scrolls `container` so `el` comes to rest `JUMP_OFFSET` px below its top edge.
 *
 * The measurement and the scroll happen in two different coordinate spaces.
 * `getBoundingClientRect()` reports post-zoom pixels, because content zoom is a
 * `zoom` on `.markdown-container` — an ancestor of the scroller. `scrollTop`
 * and `scrollTo()` stay in the scroller's own, unzoomed units. Adding a delta
 * measured in the first to an offset expressed in the second is only correct at
 * 100%; everywhere else it is wrong by exactly the zoom factor, which at 150%
 * overshoots far enough to clamp against the end of the document. Dividing the
 * delta converts it before the two are combined.
 *
 * The jump is deliberately not animated: the reader asked for a position, and
 * an animation only delays their arrival at it.
 */
export function scrollToHeading(container: HTMLElement, el: HTMLElement): void {
	const zoomed = container.closest('.markdown-container');
	const zoom = zoomed ? parseFloat(getComputedStyle(zoomed).zoom) || 1 : 1;
	const containerRect = container.getBoundingClientRect();
	const elRect = el.getBoundingClientRect();
	container.scrollTo({ top: (elRect.top - containerRect.top) / zoom + container.scrollTop - JUMP_OFFSET });
}
