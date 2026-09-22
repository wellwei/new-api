/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  LoadingSkeleton,
  EmptyState,
  SearchBar,
  PricingTable,
  PricingSidebar,
  PricingToolbar,
  ModelCardGrid,
  ModelDetailsDrawer,
} from './components'
import { EXCLUDED_GROUPS, VIEW_MODES } from './constants'
import { useFilters } from './hooks/use-filters'
import { usePricingData } from './hooks/use-pricing-data'
import type { PricingSearch } from './search'

export interface PricingPanelProps {
  /** Active search params, owned by the route that renders the panel. */
  search: PricingSearch
  /** Model whose details are open, or null. */
  modelName: string | null
  onModelNameChange: (modelName: string | null) => void
  className?: string
}

/**
 * Model square content: filters, table/card view and the details drawer.
 *
 * Deliberately layout-free — the host route supplies the surrounding page
 * (console section or standalone public page) and owns URL state, so the panel
 * can be embedded anywhere without a second copy of the model square.
 */
export function PricingPanel(props: PricingPanelProps) {
  const { t } = useTranslation()
  const {
    models,
    vendors,
    groupRatio,
    usableGroup,
    endpointMap,
    autoGroups,
    isLoading,
    priceRate,
    usdExchangeRate,
  } = usePricingData()

  const {
    searchInput,
    sortBy,
    vendorFilter,
    groupFilter,
    quotaTypeFilter,
    endpointTypeFilter,
    tagFilter,
    tokenUnit,
    viewMode,
    showRechargePrice,
    setSearchInput,
    setSortBy,
    setVendorFilter,
    setGroupFilter,
    setQuotaTypeFilter,
    setEndpointTypeFilter,
    setTagFilter,
    setTokenUnit,
    setViewMode,
    setShowRechargePrice,
    filteredModels,
    hasActiveFilters,
    activeFilterCount,
    availableTags,
    clearFilters,
    clearSearch,
  } = useFilters(models || [], props.search)

  const selectedModel = useMemo(
    () =>
      props.modelName
        ? (models || []).find(
            (model) => model.model_name === props.modelName
          ) || null
        : null,
    [models, props.modelName]
  )

  const availableGroups = useMemo(
    () =>
      Object.keys(usableGroup || {}).filter(
        (g) => !EXCLUDED_GROUPS.includes(g)
      ),
    [usableGroup]
  )

  const handleClearAll = useCallback(() => {
    clearFilters()
    clearSearch()
  }, [clearFilters, clearSearch])

  const renderPricingContent = () => {
    if (isLoading) {
      return <LoadingSkeleton viewMode={viewMode} />
    }

    if (filteredModels.length === 0) {
      return (
        <EmptyState
          searchQuery={searchInput}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={handleClearAll}
        />
      )
    }

    if (viewMode === VIEW_MODES.CARD) {
      return (
        <ModelCardGrid
          models={filteredModels}
          onModelClick={props.onModelNameChange}
          priceRate={priceRate}
          usdExchangeRate={usdExchangeRate}
          tokenUnit={tokenUnit}
          showRechargePrice={showRechargePrice}
          selectedGroup={groupFilter}
        />
      )
    }

    return (
      <PricingTable
        models={filteredModels}
        priceRate={priceRate}
        usdExchangeRate={usdExchangeRate}
        tokenUnit={tokenUnit}
        showRechargePrice={showRechargePrice}
        selectedGroup={groupFilter}
        onModelClick={props.onModelNameChange}
      />
    )
  }

  return (
    <div className={props.className}>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <SearchBar
          value={searchInput}
          onChange={setSearchInput}
          onClear={clearSearch}
          placeholder={t('Search model name, provider, endpoint, or tag...')}
          className='min-w-0 flex-1 sm:max-w-md'
        />
        <p className='text-muted-foreground/70 text-xs'>
          {t('This site currently has {{count}} models enabled', {
            count: models?.length || 0,
          })}
        </p>
      </div>

      <div className='mt-4 grid min-h-0 flex-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)]'>
        <PricingSidebar
          quotaTypeFilter={quotaTypeFilter}
          endpointTypeFilter={endpointTypeFilter}
          vendorFilter={vendorFilter}
          groupFilter={groupFilter}
          tagFilter={tagFilter}
          onQuotaTypeChange={setQuotaTypeFilter}
          onEndpointTypeChange={setEndpointTypeFilter}
          onVendorChange={setVendorFilter}
          onGroupChange={setGroupFilter}
          onTagChange={setTagFilter}
          vendors={vendors || []}
          groups={availableGroups}
          groupRatios={groupRatio}
          tags={availableTags}
          models={models || []}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={clearFilters}
          className='hover-scrollbar hidden max-h-full self-start overflow-y-auto xl:block'
        />

        <main className='flex min-h-0 min-w-0 flex-col gap-4'>
          <PricingToolbar
            filteredCount={filteredModels.length}
            totalCount={models?.length}
            sortBy={sortBy}
            onSortChange={setSortBy}
            tokenUnit={tokenUnit}
            onTokenUnitChange={setTokenUnit}
            showRechargePrice={showRechargePrice}
            onRechargePriceChange={setShowRechargePrice}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            quotaTypeFilter={quotaTypeFilter}
            endpointTypeFilter={endpointTypeFilter}
            vendorFilter={vendorFilter}
            groupFilter={groupFilter}
            tagFilter={tagFilter}
            onQuotaTypeChange={setQuotaTypeFilter}
            onEndpointTypeChange={setEndpointTypeFilter}
            onVendorChange={setVendorFilter}
            onGroupChange={setGroupFilter}
            onTagChange={setTagFilter}
            vendors={vendors || []}
            groups={availableGroups}
            groupRatios={groupRatio}
            tags={availableTags}
            models={models || []}
            hasActiveFilters={hasActiveFilters}
            activeFilterCount={activeFilterCount}
            onClearFilters={clearFilters}
          />

          <div className='hover-scrollbar min-h-0 flex-1 overflow-y-auto'>
            {renderPricingContent()}
          </div>
        </main>
      </div>

      {selectedModel && (
        <ModelDetailsDrawer
          open={Boolean(selectedModel)}
          onOpenChange={(open) => {
            if (!open) props.onModelNameChange(null)
          }}
          model={selectedModel}
          groupRatio={groupRatio || {}}
          usableGroup={usableGroup || {}}
          endpointMap={
            (endpointMap as Record<
              string,
              { path?: string; method?: string }
            >) || {}
          }
          autoGroups={autoGroups || []}
          priceRate={priceRate ?? 1}
          usdExchangeRate={usdExchangeRate ?? 1}
          tokenUnit={tokenUnit}
          showRechargePrice={showRechargePrice}
        />
      )}
    </div>
  )
}
