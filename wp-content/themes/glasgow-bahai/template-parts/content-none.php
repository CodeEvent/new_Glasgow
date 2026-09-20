<?php
/**
 * Template part shown when no content is found.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<div class="content-wrap">
	<h2><?php esc_html_e( 'Nothing found', 'glasgow-bahai' ); ?></h2>
	<p><?php esc_html_e( 'It seems nothing matches your search. Please try again with different keywords.', 'glasgow-bahai' ); ?></p>
	<?php get_search_form(); ?>
</div>
