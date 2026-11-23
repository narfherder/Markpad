<script lang="ts">
	import { tick } from 'svelte';
	import { type Tab, tabManager } from '../stores/tabs.svelte.js';
	import { settings } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import { hasRealFilePath } from '../utils/tabFileActions.js';

	// Firefox's "List all tabs": every tab in one scrollable list, for when the
	// strip holds more than fits. Typing narrows the list by title.
	let {
		showHome = false,
		ontabclick,
		oncloseTab,
	} = $props<{
		showHome?: boolean;
		ontabclick?: () => void;
		oncloseTab?: (id: string) => void;
	}>();

	let open = $state(false);
	let query = $state('');
	let highlighted = $state(0);
	let anchor = $state({ top: 0, right: 0 });
	let buttonEl = $state<HTMLButtonElement>();
	let inputEl = $state<HTMLInputElement>();
	let listEl = $state<HTMLUListElement>();

	let matches = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return tabManager.tabs;
		return tabManager.tabs.filter((tab) => tab.title.toLowerCase().includes(needle));
	});

	// Closing a tab from the list shortens it under the highlight.
	$effect(() => {
		if (highlighted >= matches.length) highlighted = Math.max(0, matches.length - 1);
	});

	function revealHighlighted(block: ScrollLogicalPosition) {
		listEl?.children[highlighted]?.scrollIntoView({ block, behavior: 'instant' });
	}

	async function toggle() {
		if (open) {
			open = false;
			return;
		}
		if (!buttonEl) return;
		const rect = buttonEl.getBoundingClientRect();
		anchor = { top: rect.bottom + 4, right: window.innerWidth - rect.right };
		query = '';
		highlighted = Math.max(0, tabManager.tabs.findIndex((tab) => tab.id === tabManager.activeTabId));
		open = true;
		await tick();
		inputEl?.focus();
		revealHighlighted('center');
	}

	function choose(tab: Tab) {
		open = false;
		tabManager.setActive(tab.id);
		ontabclick?.();
	}

	// Keys stop here so the app's own shortcuts do not fire while typing.
	function handleKeydown(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (matches.length === 0) return;
			const step = e.key === 'ArrowDown' ? 1 : -1;
			highlighted = (highlighted + step + matches.length) % matches.length;
			revealHighlighted('nearest');
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const tab = matches[highlighted];
			if (tab) choose(tab);
		}
	}

	// Middle-click closes, as on the strip. A tab with unsaved edits asks first,
	// and that dialog must not open underneath this overlay.
	function handleAuxClick(e: MouseEvent, tab: Tab) {
		if (e.button !== 1) return;
		e.preventDefault();
		if (tab.isDirty) open = false;
		oncloseTab?.(tab.id);
	}
</script>

<button
	bind:this={buttonEl}
	class="all-tabs-btn"
	class:active={open}
	onclick={toggle}
	onmousedown={(e) => e.preventDefault()}
	title={t('tooltip.listAllTabs', settings.language)}
	aria-label={t('tooltip.listAllTabs', settings.language)}
	aria-haspopup="listbox"
	aria-expanded={open}>
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
		><polyline points="6 9 12 15 18 9"></polyline></svg>
</button>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="all-tabs-overlay" onclick={() => (open = false)} oncontextmenu={(e) => { e.preventDefault(); open = false; }}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="all-tabs-panel" style:top="{anchor.top}px" style:right="{anchor.right}px" onclick={(e) => e.stopPropagation()}>
			<input
				bind:this={inputEl}
				class="all-tabs-search"
				type="text"
				placeholder={t('tabs.searchTabs', settings.language)}
				bind:value={query}
				oninput={() => (highlighted = 0)}
				onkeydown={handleKeydown} />
			{#if matches.length === 0}
				<div class="all-tabs-empty">{t('tabs.noMatchingTabs', settings.language)}</div>
			{:else}
				<ul class="all-tabs-list" role="listbox" bind:this={listEl}>
					{#each matches as tab, i (tab.id)}
						<!-- Keyboard choice goes through the search field's Up/Down/Enter. -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<li
							role="option"
							tabindex="-1"
							aria-selected={i === highlighted}
							class:highlighted={i === highlighted}
							class:current={!showHome && tab.id === tabManager.activeTabId}
							title={hasRealFilePath(tab.path) ? tab.path : tab.title}
							onmouseenter={() => (highlighted = i)}
							onclick={() => choose(tab)}
							onmousedown={(e) => { if (e.button === 1) e.preventDefault(); }}
							onauxclick={(e) => handleAuxClick(e, tab)}>
							<span class="all-tabs-title">{tab.title}</span>
							{#if tab.isDirty}
								<span class="all-tabs-dirty"></span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.all-tabs-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin: 4px;
		border: none;
		background: transparent;
		color: var(--color-fg-muted);
		border-radius: 8px;
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background 0.1s,
			color 0.1s;
		z-index: 21;
	}

	.all-tabs-btn:hover,
	.all-tabs-btn.active {
		background: var(--color-neutral-muted);
		color: var(--color-fg-default);
	}

	.all-tabs-overlay {
		position: fixed;
		inset: 0;
		z-index: 10005;
	}

	.all-tabs-panel {
		position: fixed;
		display: flex;
		flex-direction: column;
		width: 340px;
		max-width: calc(100vw - 16px);
		max-height: min(70vh, 640px);
		padding: 4px;
		background-color: var(--color-canvas-default);
		border: 1px solid var(--color-border-default);
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
		font-family: var(--win-font);
		font-size: 13px;
		animation: allTabsFade 0.1s ease-out;
	}

	@keyframes allTabsFade {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.all-tabs-search {
		margin: 2px 2px 6px;
		padding: 6px 8px;
		font: inherit;
		color: var(--color-fg-default);
		background: transparent;
		border: 1px solid var(--color-border-default);
		border-radius: 4px;
		outline: none;
	}

	.all-tabs-search:focus {
		border-color: var(--color-accent-fg);
	}

	.all-tabs-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		min-height: 0;
	}

	.all-tabs-list li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-radius: 4px;
		color: var(--color-fg-default);
		cursor: default;
	}

	.all-tabs-list li.highlighted {
		background: var(--color-neutral-muted);
	}

	.all-tabs-list li.current {
		font-weight: 600;
		box-shadow: inset 3px 0 0 var(--color-accent-fg);
	}

	.all-tabs-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.all-tabs-dirty {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-fg-muted);
		flex-shrink: 0;
	}

	.all-tabs-empty {
		padding: 8px 10px;
		color: var(--color-fg-muted);
	}
</style>
