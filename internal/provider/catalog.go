package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Model is a catalog entry: a display name, prices in USD per million tokens (0 when unknown)
// and the context window.
type Model struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Input   float64 `json:"input,omitempty"`
	Output  float64 `json:"output,omitempty"`
	Cached  float64 `json:"cached,omitempty"`
	Context int     `json:"context,omitempty"`
}

// Catalog is the models each provider offers, from a cached snapshot of models.dev. It is
// advisory: any model id is accepted at run time, and prices only inform the cost shown.
type Catalog map[string][]Model

// CatalogURL is the public models.dev listing the snapshot comes from.
const CatalogURL = "https://models.dev/api.json"

// LoadCatalog reads the snapshot at path; a missing or damaged file is an empty catalog.
func LoadCatalog(path string) Catalog {
	b, err := os.ReadFile(path)
	if err != nil {
		return Catalog{}
	}
	var c Catalog
	if json.Unmarshal(b, &c) != nil {
		return Catalog{}
	}
	return c
}

// FetchCatalog downloads models.dev and writes a trimmed snapshot for the given providers.
func FetchCatalog(ctx context.Context, path string, providers []string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", CatalogURL, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("cannot fetch %s: %w", CatalogURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("cannot fetch %s: HTTP %d", CatalogURL, res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return err
	}
	var raw map[string]struct {
		Models map[string]struct {
			Name string `json:"name"`
			Cost struct {
				Input     float64 `json:"input"`
				Output    float64 `json:"output"`
				CacheRead float64 `json:"cache_read"`
			} `json:"cost"`
			Limit struct {
				Context int `json:"context"`
			} `json:"limit"`
		} `json:"models"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return fmt.Errorf("cannot read the models.dev listing: %w", err)
	}
	c := Catalog{}
	for _, name := range providers {
		p, ok := raw[name]
		if !ok {
			continue
		}
		list := []Model{}
		for id, m := range p.Models {
			list = append(list, Model{ID: id, Name: m.Name, Input: m.Cost.Input, Output: m.Cost.Output, Cached: m.Cost.CacheRead, Context: m.Limit.Context})
		}
		sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
		c[name] = list
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	out, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(path, append(out, '\n'), 0600)
}

// Find returns a provider's entry for a model id, matched without regard to case.
func (c Catalog) Find(provider, id string) (Model, bool) {
	for _, m := range c[provider] {
		if strings.EqualFold(m.ID, id) {
			return m, true
		}
	}
	return Model{}, false
}

// Cost prices usage with the catalog, or nil when the model's prices are unknown.
func (c Catalog) Cost(provider, id string, u Usage) *float64 {
	m, ok := c.Find(provider, id)
	if !ok || m.Input == 0 && m.Output == 0 {
		return nil
	}
	fresh := float64(u.Input - u.Cached)
	cost := (fresh*m.Input + float64(u.Cached)*m.Cached + float64(u.Output)*m.Output) / 1e6
	return &cost
}
