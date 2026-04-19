package nhentai

// Gallery represents the nhentai gallery metadata payload.
type Gallery struct {
	ID           int          `json:"id"`
	MediaID      string       `json:"media_id"`
	Title        GalleryTitle `json:"title"`
	Cover        Image        `json:"cover"`
	Scanlator    string       `json:"scanlator"`
	UploadDate   int64        `json:"upload_date"`
	Tags         []Tag        `json:"tags"`
	NumPages     int          `json:"num_pages"`
	NumFavorites int          `json:"num_favorites"`
	Pages        []Page       `json:"pages"`
}

// GalleryTitle contains localized title variants for a gallery.
type GalleryTitle struct {
	English  string `json:"english"`
	Japanese string `json:"japanese"`
	Pretty   string `json:"pretty"`
}

// Tag describes a gallery taxonomy label such as artist or language.
type Tag struct {
	ID   int    `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	URL  string `json:"url"`
}

// Page describes an individual gallery image page.
type Page struct {
	Number int    `json:"number"`
	Path   string `json:"path"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// Image represents an nhentai image resource.
type Image struct {
	Path   string `json:"path"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}
