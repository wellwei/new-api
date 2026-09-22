package service

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 榜单只列模型广场里能看到的模型（meta 键集）。用法日志里的名字是请求侧原样记下的，
// 混着上游分区前缀（cn:auto）、线路后缀（deepseek-v4.1-flash-sg）与已融合的变体
// （hy3-x / kimi-k3-1）——这些排进公开榜单就是把上游的分区与线路标注端给用户。
func TestRankingsOnlyListsOfferedModels(t *testing.T) {
	meta := map[string]rankingModelMeta{
		"deepseek-v4.1-flash":        {vendor: "DeepSeek"},
		"hy3":                        {vendor: "Tencent TokenHub"},
		"muse-spark-1.3-contributor": {vendor: "Meta"},
	}

	totals := []model.RankingQuotaTotal{
		{ModelName: "deepseek-v4.1-flash", TotalTokens: 400_000_000},
		{ModelName: "deepseek-v4.1-flash-sg", TotalTokens: 43_000_000}, // 线路后缀
		{ModelName: "cn:auto", TotalTokens: 12_000_000},                // 上游分区前缀
		{ModelName: "hy3", TotalTokens: 6_000_000},
		{ModelName: "hy3-x", TotalTokens: 22_000_000},                  // 已融合的变体
		{ModelName: "kimi-k3-1", TotalTokens: 16_000_000},              // 已融合的变体
		{ModelName: "muse-spark-1.3-contributor", TotalTokens: 63_000}, // 占比最末
	}

	filtered := filterOfferedModels(totals, meta)
	names := make([]string, 0, len(filtered))
	for _, item := range filtered {
		names = append(names, item.ModelName)
	}
	assert.Equal(t, []string{
		"deepseek-v4.1-flash",
		"hy3",
		"muse-spark-1.3-contributor",
	}, names)

	// 份额的分母必须是过滤后的合计：否则被隐藏的模型留在分母里，
	// 可见模型的占比会被压小，而用户看到的百分比与实际对不上。
	total := sumRankingTokens(filtered)
	assert.Equal(t, int64(400_000_000+6_000_000+63_000), total)

	ranked := buildRankedModels(filtered, total, map[string]int{}, map[string]int64{}, meta, false)
	require.Len(t, ranked, 3)
	for idx, row := range ranked {
		assert.Equal(t, idx+1, row.Rank)
		assert.NotEqual(t, rankingUnknownVendor, row.Vendor)
	}
	assert.InDelta(t, 1.0, ranked[0].Share+ranked[1].Share+ranked[2].Share, 0.0001)
}

// 历史曲线走的是另一张表（buckets），同一条规则必须覆盖它，否则「热门模型」图里
// 还会留下榜单列表已经藏掉的名字。
func TestRankingHistoryOnlyListsOfferedModels(t *testing.T) {
	meta := map[string]rankingModelMeta{"hy3": {vendor: "Tencent TokenHub"}}

	buckets := []model.RankingQuotaBucket{
		{ModelName: "hy3", Bucket: 100, Tokens: 10},
		{ModelName: "cn:fast-model", Bucket: 100, Tokens: 99},
		{ModelName: "hy4-preview-f", Bucket: 200, Tokens: 5},
	}

	filtered := filterOfferedBuckets(buckets, meta)
	require.Len(t, filtered, 1)
	assert.Equal(t, "hy3", filtered[0].ModelName)
}

// 全空输入不能panic，也不能把 nil 变成非 nil 空切片（调用方按长度判断有没有数据）。
func TestRankingsFilterKeepsEmptyInput(t *testing.T) {
	meta := map[string]rankingModelMeta{}

	assert.Nil(t, filterOfferedModels(nil, meta))
	assert.Nil(t, filterOfferedBuckets(nil, meta))
	assert.Empty(t, filterOfferedModels([]model.RankingQuotaTotal{}, meta))
}

// 一个都没匹配上时返回空切片而不是留下未过滤的行——宁可榜单空着，
// 也不退回「把内部名字露出去」的旧行为。
func TestRankingsFilterDropsEverythingWhenNothingOffered(t *testing.T) {
	meta := map[string]rankingModelMeta{}
	totals := []model.RankingQuotaTotal{{ModelName: "cn:auto", TotalTokens: 1000}}

	assert.Empty(t, filterOfferedModels(totals, meta))
}

// 榜单一律以「在售且目录可见」为准：meta 里没有的名字即使有海量用量也不出现。
func TestRankingsGrowthComparisonUsesVisibleSet(t *testing.T) {
	meta := map[string]rankingModelMeta{"hy3": {vendor: "Tencent TokenHub"}}
	current := filterOfferedModels([]model.RankingQuotaTotal{
		{ModelName: "hy3", TotalTokens: 200},
		{ModelName: "kimi-k3-1", TotalTokens: 100},
	}, meta)
	previous := filterOfferedModels([]model.RankingQuotaTotal{
		{ModelName: "hy3", TotalTokens: 100},
		{ModelName: "kimi-k3-1", TotalTokens: 50},
	}, meta)

	ranked := buildRankedModels(current, sumRankingTokens(current),
		rankingRankMap(previous), rankingTokenMap(previous), meta, true)
	require.Len(t, ranked, 1)
	assert.Equal(t, "hy3", ranked[0].ModelName)
	assert.Equal(t, 100.0, ranked[0].GrowthPct)
}
