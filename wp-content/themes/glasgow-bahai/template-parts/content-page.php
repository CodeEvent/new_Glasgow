<?php
/**
 * Template part for displaying page content.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<article id="post-<?php the_ID(); ?>" <?php post_class( 'content-wrap' ); ?>>
	<?php if ( has_post_thumbnail() ) : ?>
		<?php the_post_thumbnail( 'large' ); ?>
	<?php endif; ?>

	<div class="entry-content">
		<?php the_content(); ?>
	</div>
</article>
